import { markBusinessKeyWriter } from "../components/container/fenced-reach.js";
import { fencedErrorOf } from "../app/handed-over.js";
import { scopeKeyOf } from "../app/lease-lost.js";
import { currentFrame, type FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import { FencedEffectEventOutcome } from "./execution-audit-log.repository.js";
import type { EffectKey, FencedEffectOrigin } from "./effect-key.js";
import { LeaseCheck, type StoreDescriptor } from "./execution-lease.repository.js";
import { isIssuedKey } from "./issued-keys.js";
import {
  businessKeyErrorOf,
  effectKeyIdentityOf,
  fingerprintErrorOf,
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
export type JsonValue<T> = T extends JsonPrimitive
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { readonly [K in keyof T]: JsonValue<T[K]> }
      : never;

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

/**
 * The protected write: business rows in `transaction`, then its result (plain JSON). A store may
 * run it more than once within one call (#730: MongoDB's driver runs an aborted attempt again on a
 * transient transaction error), keeping only the last attempt's writes: it writes only through
 * `transaction` and does nothing else — no call to another system, nothing sent or counted outside.
 */
export type FencedEffectWork<TTransaction, TResult> = (
  transaction: TTransaction,
) => (TResult & JsonValue<TResult>) | Promise<TResult & JsonValue<TResult>>;

/** A key made by hand that is not one of a lease scope. */
class InvalidFencedEffectKeyError extends TypeError {
  override name = "InvalidFencedEffectKeyError";
}

/** Why a key made by hand is refused (#825). */
const UNISSUED_KEY =
  "not a fenced effect key: make it with effectKeyOf(executionContext, name, …) — a copy or an object built by hand is no key (effectKeyForTesting in a store's tests)";

/** Why a key cannot be one: its scope does not match its parts, no name, no token. */
function keyProblemOf(key: EffectKey): string | undefined {
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
 * reaches the transaction, which refuses it (`BusinessKeyConflictError`). No fingerprint is
 * `null` and every text, `""` too, is itself (#574): as `replayedFromOf` tells them apart.
 */
const joinKeyOf = (key: EffectKey): string =>
  JSON.stringify([key.scopeKey, effectKeyIdentityOf(key), key.token, key.fingerprint ?? null]);

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
   * Where the store's rows live and how it checks the lease against its write (#526, #825): its
   * `backend` must be the application's lease store's — its write and the lease check are one
   * transaction (a unit runner holds its lease in the lease store of that backend). `backend`
   * undefined: undeclared, which fails assembly (`[application.store-backend-undeclared]`) unless the
   * store opts out with `leaseCheck: LeaseCheck.WithoutDoubleChargeProtection`, which names what is lost.
   */
  static readonly store: StoreDescriptor = { backend: undefined, leaseCheck: LeaseCheck.Atomic };

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
   * the next call runs it again. `work` may run more than once within one call (an aborted attempt
   * run again, as on MongoDB, #730): only the last attempt's writes are kept. Concurrent calls on one key of this instance share the first's
   * outcome (`Joined`); across instances the transaction serializes them (`Replayed`).
   */
  runOnce<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    // #825: no key at all from JavaScript is refused as one effectKeyOf did not make, not a throw
    const given: unknown = key;
    if (typeof given !== "object" || given === null)
      return Promise.reject(new InvalidFencedEffectKeyError(UNISSUED_KEY));
    // the name first, as every store checks it at its entry (#508, #526 AC7)
    if (!isEffectName(key.name))
      return Promise.reject(new InvalidFencedEffectNameError(key.name.length));
    // the business key's text (#538): its own error, naming the rule, never the key
    const invalidKey = businessKeyErrorOf(key);
    if (invalidKey !== undefined) return Promise.reject(invalidKey);
    // #825: a fenced effect under a business key says what it does, or says on purpose it does not
    const unfingerprinted = fingerprintErrorOf(key);
    if (unfingerprinted !== undefined) return Promise.reject(unfingerprinted);
    // #825: a key effectKeyOf made — a copy or a hand-built object from JavaScript is refused
    if (!isIssuedKey(key)) return Promise.reject(new InvalidFencedEffectKeyError(UNISSUED_KEY));
    const problem = keyProblemOf(key);
    if (problem !== undefined)
      return Promise.reject(new InvalidFencedEffectKeyError(`not a fenced effect key: ${problem}`));
    return observedCall(key, currentFrame(), this.#call(key, work));
  }

  /** The call itself: the leader's transaction, or the outcome of the leader on its key. */
  #call<TResult>(
    key: EffectKey,
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
   * One transaction, in this order: the lease (the stored lease's `token !== key.token`, released, expired →
   * fenced), the mark (`token < highest` → fenced, else `highest = max(highest, token)`), the key
   * (found → `Replayed`, `work` not called), the write (`work`, then the result stored with its
   * token and the `Clock`'s time → `Ran`). Rolled back as a whole when anything throws.
   */
  protected abstract runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>>;

  /** Removes the results and marks stored before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteByStoredAtBefore(cutoff: Date): Promise<void>;

  /**
   * The result as stored: its JSON, within `maxResultSize` (UTF-8 bytes) — else
   * `FencedEffectResultTooLargeError`, thrown inside the transaction so it rolls back.
   */
  protected storedResultOf(key: EffectKey, result: unknown): string {
    const text = JSON.stringify(result);
    // Stryker disable next-line StringLiteral: `Buffer.byteLength` counts UTF-8 for an empty encoding as for "utf8"
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

// #825: a component that reaches any fenced-effect store can write under a business key
markBusinessKeyWriter(FencedEffectRepository);

/** How the audit log names each outcome of a call. */
const LOGGED_OUTCOME: Readonly<Record<FencedEffectStatus, FencedEffectEventOutcome>> = {
  [FencedEffectStatus.Ran]: FencedEffectEventOutcome.Ran,
  [FencedEffectStatus.Replayed]: FencedEffectEventOutcome.Replayed,
  [FencedEffectStatus.Joined]: FencedEffectEventOutcome.Joined,
};

/**
 * The call, told to the lease the step runs under (#501): how it went — ran, replayed, joined, or
 * refused (`ExecutionFencedError`) — as a row of the audit log and `onFencedEffect`, never its
 * result; a failure of the write itself is no outcome. Nothing outside a step or under a lease that
 * does not record (a unit runner's).
 */
function observedCall<TResult>(
  key: EffectKey,
  frame: FrameSpec | undefined,
  call: Promise<FencedEffectOutcome<TResult>>,
): Promise<FencedEffectOutcome<TResult>> {
  return frame === undefined ? call : observedInStep(key, frame, call);
}

/** `observedCall` in a step's frame: told to its lease, unless that lease does not record. */
function observedInStep<TResult>(
  key: EffectKey,
  frame: FrameSpec,
  call: Promise<FencedEffectOutcome<TResult>>,
): Promise<FencedEffectOutcome<TResult>> {
  const { lease } = frame.execution;
  if (lease?.recordFencedEffect === undefined) return call;
  const record = lease.recordFencedEffect.bind(lease);
  const { name, scopeKey, token } = key;
  const report = (outcome: FencedEffectEventOutcome, tokens: object): void => {
    record({
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

export type {
  EffectKey,
  EffectKeyFields,
  FencedEffectOrigin,
  OutboundCallKey,
} from "./effect-key.js";
export {
  effectKeyOf,
  FingerprintNotJsonError,
  FingerprintPolicy,
  FingerprintRequiredError,
  BusinessKeyConflictError,
  IdempotencyKeyMissingError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
  type BusinessKeyOptions,
  type EffectKeyOptions,
  type FingerprintedKeyOptions,
  type FingerprintKeys,
  type UnfingerprintedKeyOptions,
  type OutboundCallKeyOptions,
  type BusinessKeyConflictErrorOptions,
  type FingerprintNotJsonErrorOptions,
  type InvalidBusinessKeyErrorOptions,
} from "./fenced-effect-key.js";
export {
  FencedEffectResultTooLargeError,
  type FencedEffectResultTooLargeErrorOptions,
} from "./fenced-effect-settings.js";
