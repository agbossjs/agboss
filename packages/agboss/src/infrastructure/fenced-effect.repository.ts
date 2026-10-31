import { fencedErrorOf } from "../app/handed-over.js";
import { scopeKeyOf } from "../app/lease-lost.js";
import { currentFrame, type FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import { FencedEffectEventOutcome } from "./execution-lease-event.repository.js";
import type { Class } from "../components/injection.js";
import { LeaseCheck } from "./execution-lease.repository.js";
import {
  businessKeyErrorOf,
  fencedKeyIdentityOf,
  InvalidFencedEffectNameError,
  isEffectName,
} from "./fenced-effect-key.js";
import { FencedEffectResultTooLargeError } from "./fenced-effect-settings.js";
import type { FencedEffectSettings } from "./fenced-effect-settings.js";

/**
 * The fenced effect (#500): one protected write of a step, made exactly once per step on the
 * store's own database — a durable singleflight on the step's idempotency key. In one transaction
 * with the write: the lease the step runs under is checked (`ExecutionFencedError` when it is no
 * longer the current one), then the scope's high-water mark (`token < highest` refused before any
 * key is looked up, so a zombie never reads the new holder's result), then the key — found, the
 * stored result comes back and the write does not run again. Wiki → Several-instances.
 */

/** The values JSON keeps as they are. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * `T` as a fenced effect stores it — `JSON.stringify`, then `JSON.parse` on a replay: text,
 * numbers, booleans, `null`, arrays and objects of them (an interface, a DTO class, optional
 * fields); a function, `undefined`, a `Date` or a `Map` is `never`, so a write returning one does
 * not compile.
 */
export type JsonResult<T> = T extends JsonPrimitive
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { readonly [K in keyof T]: JsonResult<T[K]> }
      : never;

/** The identity of one protected write: the lease scope and token it runs under, the step, a name. */
export interface FencedEffectKey {
  /** `executionContext.fence.scopeKey`: the lease scope, the key of its high-water mark. */
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The execution whose lease the step runs under (`executionContext.fence.leaseExecutionId`). */
  readonly leaseExecutionId: string;
  /** The lease's epoch the step holds (`executionContext.fence.token`). */
  readonly token: number;
  /** The step's `executionContext.step.idempotencyKey`: the same when the step runs again. */
  readonly idempotencyKey: string;
  /** Which effect of the step: `"charge"`, `"notify-ledger"` — several in one step are apart. */
  readonly name: string;
  /**
   * A business identity (#508, `"order:42"`): the effect is then one per tenant, name and business
   * key — deduplicated across tool calls, visits, executions and threads — instead of one per step.
   * Fencing is the caller's lease as always. A key's text (#538, `KeyTextRule`): validated by
   * `fencedEffectKeyOf`, `OutboundCalls.send` and every store's entry (`InvalidBusinessKeyError`).
   */
  readonly businessKey?: string;
  /**
   * What the effect does, as a hash (SHA-256 of canonical JSON): another one under the same
   * business key is `IdempotencyKeyConflictError`, never a replay. Any text is a fingerprint, the
   * empty one too (#574): `""` and none are two requests — refused against each other, in flight or
   * stored, so a store keeps `""` as `""`, never as `NULL`.
   */
  readonly fingerprint?: string;
  /** The step that made the key: what a replay from another step or execution names. */
  readonly origin?: FencedEffectOrigin;
  /**
   * The business key's handle (#508): 12 hex characters of its HMAC-SHA256 under the execution's PII
   * key — what an error shows instead of the key, to match it with the caller's own log. None where
   * no key is available (a key made by hand, outside an execution): an error then shows none.
   */
  readonly businessKeyHash?: string;
}

/** A step, as a replay from another one names it (#508). */
export interface FencedEffectOrigin {
  readonly executionId: string;
  readonly nodeId: string;
  readonly visitNumber: number;
}

/** How a call got its result. */
export enum FencedEffectStatus {
  /** The write ran now, and its result was stored with it. */
  Ran = "ran",
  /** The key was written before (a step run again): the stored result, the write not run. */
  Replayed = "replayed",
  /** A call on the same key of this instance was in flight: its result (or its error). */
  Joined = "joined",
}

/** What a call gives: how it got the result, the result, the token it was first written under. */
export interface FencedEffectOutcome<TResult> {
  readonly status: FencedEffectStatus;
  readonly result: TResult;
  /** The token the result was first written under (a replay on a newer lease: the older one). */
  readonly token: number;
  /** A business key's replay of what another step or execution wrote (#508): that step. */
  readonly replayedFrom?: FencedEffectOrigin;
}

/** The protected write: business rows in `transaction`, then its result (plain JSON). */
export type FencedEffectWork<TTransaction, TResult> = (
  transaction: TTransaction,
) => (TResult & JsonResult<TResult>) | Promise<TResult & JsonResult<TResult>>;

/** A key made by hand that is not one of a lease scope. */
class InvalidFencedEffectKeyError extends TypeError {
  override name = "InvalidFencedEffectKeyError";
}

/** Why a key cannot be one: its scope does not match its parts, no name, no token. */
function keyProblemOf(key: FencedEffectKey): string | undefined {
  if (key.scopeKey !== scopeKeyOf(key.tenantId, key.leaseExecutionId))
    return `its scopeKey ${JSON.stringify(key.scopeKey)} is not the scope of tenant ${key.tenantId} and execution ${key.leaseExecutionId}`;
  if (!Number.isInteger(key.token) || key.token < 1)
    return `its token ${String(key.token)} is not a lease epoch (a whole number from 1)`;
  if (key.idempotencyKey.length === 0) return "its idempotencyKey must not be empty";
  return undefined;
}

/** The calls in flight of each store instance, by their full key: the in-process join. */
const inFlight = new WeakMap<object, Map<string, Promise<FencedEffectOutcome<unknown>>>>();

/**
 * The calls one leader is joined by: the same scope, identity and token — and the same fingerprint
 * (#508), so a call with other parameters under a business key never gets another call's result: it
 * reaches the transaction, which refuses it (`IdempotencyKeyConflictError`). No fingerprint is
 * `null` and every text, `""` too, is itself (#574): as `replayedFromOf` tells them apart.
 */
const joinKeyOf = (key: FencedEffectKey): string =>
  JSON.stringify([key.scopeKey, fencedKeyIdentityOf(key), key.token, key.fingerprint ?? null]);

/**
 * Infrastructure (#500): one protected write per key, inside the store's own transaction — the
 * business rows of the write live in the same database, so an application defines no fencing or
 * idempotency tables of its own. Listed only in `@Application({ providers })`; the built-in default
 * is in memory (`InMemoryFencedEffectRepository`), `SqliteFencedEffectRepository` shares the
 * application's SQLite file. A store reads the leases of the lease store on its own database, so
 * the application lists the two together.
 */
export abstract class FencedEffectRepository<TTransaction> {
  /**
   * The lease store whose leases the store checks in its transaction — the one of its database
   * (`SqliteExecutionLeaseRepository` for the SQLite store): a unit runner (`testAction`,
   * `testTool`) holds its lease there. Assembly checks `backend`, not this.
   */
  static readonly leaseRepository: Class | undefined = undefined;

  /**
   * The backend the store's rows live in (#526, as `ExecutionLeaseRepository.backend`): listed, it
   * must be the application's lease store's — its write and the lease check are one transaction.
   * Unset: undeclared, which fails assembly (`[application.store-backend-undeclared]`) unless the
   * store opts out with `leaseCheck`.
   */
  static readonly backend: string | undefined = undefined;

  /**
   * How the store checks the lease against its write (#526): `LeaseCheck.Atomic` (checked at
   * assembly), or the opt-out `LeaseCheck.WithoutDoubleChargeProtection`, which names what is lost.
   */
  static readonly leaseCheck: LeaseCheck = LeaseCheck.Atomic;

  constructor(
    /** `@Application({ fencedEffects })`: the largest result, how long rows are kept. */
    protected readonly settings: FencedEffectSettings,
  ) {}

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * The write and its result in one transaction with the fencing checks; the stored result on a
   * repeat. A refused lease or a lower token → `ExecutionFencedError` (a hand-over: nothing
   * written, no result); `work` throws → everything rolled back and the error rethrown as it is —
   * the next call runs it again. Concurrent calls on one key of this instance share the first's
   * outcome (`Joined`); across instances the transaction serializes them (`Replayed`).
   */
  saveResultIfAbsent<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    // the name first, as every store checks it at its entry (#508, #526 AC7)
    if (!isEffectName(key.name))
      return Promise.reject(new InvalidFencedEffectNameError(key.name.length));
    // the business key's text (#538): its own error, naming the rule, never the key
    const invalidKey = businessKeyErrorOf(key);
    if (invalidKey !== undefined) return Promise.reject(invalidKey);
    const problem = keyProblemOf(key);
    if (problem !== undefined)
      return Promise.reject(new InvalidFencedEffectKeyError(`not a fenced effect key: ${problem}`));
    return observedCall(key, currentFrame(), this.#call(key, work));
  }

  /** The call itself: the leader's transaction, or the outcome of the leader on its key. */
  #call<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const calls = inFlight.get(this) ?? new Map<string, Promise<FencedEffectOutcome<unknown>>>();
    inFlight.set(this, calls);
    const joinKey = joinKeyOf(key);
    const leader = calls.get(joinKey);
    // a follower's result is the leader's, of the same key and so of the same work's type
    if (leader !== undefined)
      return leader.then(joinedOutcome) as Promise<FencedEffectOutcome<TResult>>;
    const call = this.runInTransaction(key, work).finally(() => {
      calls.delete(joinKey);
    });
    calls.set(joinKey, call);
    return call;
  }

  /**
   * One transaction, in this order: the lease (`leaseEpoch !== token`, released, expired →
   * fenced), the mark (`token < highest` → fenced, else `highest = max(highest, token)`), the key
   * (found → `Replayed`, `work` not called), the write (`work`, then the result stored with its
   * token and the `Clock`'s time → `Ran`). Rolled back as a whole when anything throws.
   */
  protected abstract runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>>;

  /** Removes the results and marks stored before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteByStoredAtBefore(cutoff: Date): Promise<void>;

  /**
   * The result as stored: its JSON, within `maxResultSize` (UTF-8 bytes) — else
   * `FencedEffectResultTooLargeError`, thrown inside the transaction so it rolls back.
   */
  protected storedResultOf(key: FencedEffectKey, result: unknown): string {
    const text = JSON.stringify(result);
    const size = Buffer.byteLength(text, "utf8");
    if (size > this.settings.maxResultSize)
      throw new FencedEffectResultTooLargeError({
        effect: key.name,
        size,
        maxResultSize: this.settings.maxResultSize,
      });
    return text;
  }
}

/** How the lease log names each outcome of a call. */
const LOGGED_OUTCOME: Readonly<Record<FencedEffectStatus, FencedEffectEventOutcome>> = {
  [FencedEffectStatus.Ran]: FencedEffectEventOutcome.Ran,
  [FencedEffectStatus.Replayed]: FencedEffectEventOutcome.Replayed,
  [FencedEffectStatus.Joined]: FencedEffectEventOutcome.Joined,
};

/**
 * The call, told to the lease the step runs under (#501): how it went — ran, replayed, joined, or
 * refused (`ExecutionFencedError`) — as a row of the lease log and `onFencedEffect`, never its
 * result; a failure of the write itself is no outcome. Nothing outside a step or under a lease that
 * does not record (a unit runner's).
 */
function observedCall<TResult>(
  key: FencedEffectKey,
  frame: FrameSpec | undefined,
  call: Promise<FencedEffectOutcome<TResult>>,
): Promise<FencedEffectOutcome<TResult>> {
  const lease = frame?.execution.lease;
  if (frame === undefined || lease?.recordFencedEffect === undefined) return call;
  const { name, scopeKey, token } = key;
  const report = (outcome: FencedEffectEventOutcome, tokens: object): void => {
    lease.recordFencedEffect?.({
      event: nodeEventOf(frame),
      name,
      scopeKey,
      token,
      outcome,
      ...tokens,
    });
  };
  return call.then(
    (outcome) => {
      const { replayedFrom } = outcome;
      report(LOGGED_OUTCOME[outcome.status], {
        writtenToken: outcome.token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      });
      return outcome;
    },
    (error: unknown) => {
      const fenced = fencedErrorOf(error);
      if (fenced !== undefined)
        report(FencedEffectEventOutcome.Refused, { observedToken: fenced.observedToken });
      throw error;
    },
  );
}

/** A follower's outcome: the leader's, a copy of its result. */
const joinedOutcome = (outcome: FencedEffectOutcome<unknown>): FencedEffectOutcome<unknown> => ({
  status: FencedEffectStatus.Joined,
  result: structuredClone(outcome.result),
  token: outcome.token,
});

export {
  fencedEffectKeyOf,
  IdempotencyKeyConflictError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
  type FencedEffectKeyOptions,
  type IdempotencyKeyConflictErrorOptions,
  type InvalidBusinessKeyErrorOptions,
} from "./fenced-effect-key.js";
export {
  FencedEffectResultTooLargeError,
  type FencedEffectResultTooLargeErrorOptions,
} from "./fenced-effect-settings.js";
