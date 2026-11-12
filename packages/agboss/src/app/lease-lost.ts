import { AGBossError, ExecutionCancelledError } from "../core/errors.js";
import type { EffectKey } from "../infrastructure/effect-key.js";
import { definedOf } from "../infrastructure/clock.js";
import type { ExecutionLease } from "../infrastructure/execution-lease.repository.js";

/** What a lost lease takes (#906): the execution whose lease it was. */
export interface ExecutionLeaseLostErrorOptions {
  /** The execution whose lease was lost: the root of the tree, or a child with a lease of its own. */
  readonly rootExecutionId: string;
  readonly cause?: unknown;
}

/**
 * The instance lost the lease of the tree it was moving (#265, Q58): the lease expired — the holder
 * was frozen or cut off longer than the lease, or its store never confirmed a renewal (#335) — and
 * another instance took it or may take it now, and continues the tree. Not a failure of the
 * execution: it reaches neither `.onError`, `onError` nor the record; only the moving call rejects.
 */
export class ExecutionLeaseLostError extends AGBossError {
  static override readonly code: string = "execution.lease-lost";
  /** This class's code, or its subclass `ExecutionFencedError`'s (#906: `switch (error.code)` narrows). */
  declare readonly code: "execution.lease-lost" | "execution.lease-lost.fenced";
  override name = "ExecutionLeaseLostError";
  /**
   * The execution whose lease was lost: the root of the tree, or a `ChildPlacement.AnyInstance`
   * child that holds a lease of its own (#333) — the historic name of `ExecutionLease.rootExecutionId`.
   */
  readonly rootExecutionId: string;

  constructor(options: ExecutionLeaseLostErrorOptions) {
    const { rootExecutionId, cause } = options;
    super(
      `the lease of execution ${rootExecutionId} is over — it expired, or another instance took it: this instance stops, the next take of the lease continues the execution`,
      { cause },
    );
    this.rootExecutionId = rootExecutionId;
  }
}

/**
 * The lease ran out without a renewal the store confirmed (#335 S1): no other instance took it
 * yet, so only the message differs — the class, `code` and fields are `ExecutionLeaseLostError`'s.
 */
export function leaseExpiredError(rootExecutionId: string): ExecutionLeaseLostError {
  const error = new ExecutionLeaseLostError({ rootExecutionId });
  // #567: nothing says another instance exists — the next take may be this instance's own sweep
  error.message = `the lease of execution ${rootExecutionId} expired before its store confirmed a renewal — the holder was frozen, or its store did not answer, for longer than the lease: this instance stops, the next take of the lease continues the execution`;
  return error;
}

/**
 * The lease was over when its holder reclaimed it after waiting for remote children (#516): the
 * holder was frozen or cut off longer than the lease — at its expiry the lease is over for its holder
 * too, taken by another instance or not (#534) — only the message differs, as for `leaseExpiredError`.
 */
export function leaseTakenWhileYieldedError(rootExecutionId: string): ExecutionLeaseLostError {
  const error = new ExecutionLeaseLostError({ rootExecutionId });
  error.message = `the lease of execution ${rootExecutionId} is over — it expired while it waited for remote children, or another instance took it: this instance stops, the next take of the lease continues the execution`;
  return error;
}

/**
 * The key of one lease scope (#471): `${encodeURIComponent(tenantId)}:${encodeURIComponent(leaseExecutionId)}`
 * — exactly one `:`, so two scopes never collide and the parts decode back. A public format.
 */
export const scopeKeyOf = (tenantId: string, leaseExecutionId: string): string =>
  `${encodeURIComponent(tenantId)}:${encodeURIComponent(leaseExecutionId)}`;

/** The tenant and execution of a scope key; `undefined` for a text that is not one. */
export function scopeOfKey(
  scopeKey: string,
): { readonly tenantId: string; readonly leaseExecutionId: string } | undefined {
  const parts = scopeKey.split(":");
  if (parts.length !== 2) return undefined;
  const [tenant = "", execution = ""] = parts;
  try {
    return {
      tenantId: decodeURIComponent(tenant),
      leaseExecutionId: decodeURIComponent(execution),
    };
  } catch {
    return undefined;
  }
}

/** What an external write that was refused knows: the scope it wrote for and the tokens. */
export interface FencedWriteRefusal {
  /** `executionContext.fence.scopeKey` of the refused write. */
  readonly scopeKey: string;
  /** The token the refused write carried (`executionContext.fence.token`). */
  readonly token: number;
  /** The highest token the external system saw for the scope, when it says. */
  readonly observedToken?: number | undefined;
  /** What made the store refuse, when it has one (its own error). */
  readonly cause?: unknown;
}

/** Every fact of a refused write (#890): its scope key and that key's parts, and the tokens. */
export interface ExecutionFencedErrorOptions extends FencedWriteRefusal {
  /** The scope's tenant (the scope key's first part). */
  readonly tenantId: string;
  /** The execution whose lease the write ran under (the scope key's second part). */
  readonly leaseExecutionId: string;
}

class InvalidScopeKeyError extends TypeError {
  override name = "InvalidScopeKeyError";
}

/**
 * An external system refused a write of this execution (#471): it saw a newer token of the lease's
 * scope (`observedToken > token`, a newer take holds the lease), or — a store of the core's — the
 * lease is over at the write's token (expired, released, never taken; #567: its message says only
 * that). A hand-over, like the
 * lease lost it extends: no `.onError`, no compensation, no failed record — the moving call rejects
 * with it, and the tree goes on where the lease is held. `fence.fencedError(observedToken)` builds it for
 * the current step; a repository that has only what it wrote builds it from the scope key
 * (`ExecutionFencedError.of({ scopeKey, token, observedToken })`).
 */
export class ExecutionFencedError extends ExecutionLeaseLostError {
  static override readonly code = "execution.lease-lost.fenced" as const;
  declare readonly code: typeof ExecutionFencedError.code;
  override name = "ExecutionFencedError";
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The execution whose lease the write ran under (equals the inherited `rootExecutionId`). */
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly observedToken: number | undefined;

  /**
   * The refusal of a write that knows only its scope key and tokens — a repository's (#890): the
   * key read into its tenant and execution; one that is no scope key (`<tenant>:<execution>`, each
   * URI-encoded) is a `TypeError` here, where the store builds it, never in the constructor.
   */
  static of(refusal: FencedWriteRefusal): ExecutionFencedError {
    const scope = scopeOfKey(refusal.scopeKey);
    if (scope === undefined)
      throw new InvalidScopeKeyError(
        `${JSON.stringify(refusal.scopeKey)} is not a scope key (executionContext.fence.scopeKey)`,
      );
    return new ExecutionFencedError({ ...refusal, ...scope });
  }

  /** Every fact given as is: it never throws — a store's `catch` builds it safely (#890). */
  constructor(options: ExecutionFencedErrorOptions) {
    const { scopeKey, tenantId, leaseExecutionId, token, observedToken, cause } = options;
    super({ rootExecutionId: leaseExecutionId, cause });
    this.scopeKey = scopeKey;
    this.tenantId = tenantId;
    this.leaseExecutionId = leaseExecutionId;
    this.token = token;
    this.observedToken = observedToken;
    this.message = `a write of lease scope ${scopeKey} with token ${String(token)} was refused: ${fencedReasonOf(options)}`;
  }
}

/**
 * Why a write was fenced, as far as the refusal knows (#567): a newer token seen is a newer take of
 * the lease; the same token or none seen is only a lease that is over — expired, released, or taken
 * by a take the refusing system did not see yet. Never a claim that another instance holds it.
 */
function fencedReasonOf({ token, observedToken }: FencedWriteRefusal): string {
  if (observedToken !== undefined && observedToken > token)
    return `the external system saw token ${String(observedToken)} — a newer take of the lease: this instance stops, the holder of token ${String(observedToken)} continues the execution`;
  const seen =
    observedToken === undefined
      ? "the external system named no newer token"
      : `the external system saw token ${String(observedToken)}, no newer take`;
  return `${seen} — the lease is over: it expired, was released, or another instance took it; this instance stops, the next take of the lease continues the execution`;
}

/**
 * A `HeldLease`'s current lease where an invariant of the holder says it is defined (#619): read
 * with `definedOf`, not an `if` whose other side never runs — which a mutation test meets as an
 * equivalent mutant.
 */

/** At a release that got past its `#stopped` check: only such a release clears it. */
export const heldAtRelease = (current: ExecutionLease | undefined): ExecutionLease =>
  definedOf(
    current,
    "a held lease is cleared only by a release past its #stopped check, which a second release never gets past",
  );

/** When the yields' callback runs: it returns once `#stopped` aborts, before a release clears it. */
export const heldWhileYieldsRun = (current: ExecutionLease | undefined): ExecutionLease =>
  definedOf(
    current,
    "the yields' callback returns once #stopped aborts, which a release does before it clears the lease",
  );

/** Every fact of a write refused by its tree's cancel (#909, #906: an options bag). */
export interface ExecutionCancelFencedErrorOptions {
  /** `executionContext.fence.scopeKey` of the refused write. */
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The root of the tree whose cancel refused it. */
  readonly rootExecutionId: string;
  /** The execution whose lease the write ran under (the root, or an `AnyInstance` child). */
  readonly leaseExecutionId: string;
  readonly token: number;
  /** The effect's or the call's name, never its business key. */
  readonly effect: string;
  readonly cause?: unknown;
}

/**
 * A fenced write or an outbound call was refused because its tree's cancel request is durable
 * (#909): nothing was written or sent. Not a hand-over — the lease is held and the tree unwinds as
 * cancelled, its undo running under it; a store builds it with `ExecutionCancelFencedError.of(key)`.
 */
export class ExecutionCancelFencedError extends ExecutionCancelledError {
  static override readonly code = "execution.cancelled.fenced" as const;
  declare readonly code: typeof ExecutionCancelFencedError.code;
  override name = "ExecutionCancelFencedError";
  readonly scopeKey: string;
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly effect: string;

  /** The refusal of the write `key` names (never throws, never names a business key). */
  static of(
    key: Pick<
      EffectKey,
      "scopeKey" | "tenantId" | "leaseExecutionId" | "token" | "name" | "rootExecutionId"
    >,
  ): ExecutionCancelFencedError {
    return new ExecutionCancelFencedError({
      ...{ scopeKey: key.scopeKey, tenantId: key.tenantId, leaseExecutionId: key.leaseExecutionId },
      ...{ rootExecutionId: key.rootExecutionId ?? key.leaseExecutionId, token: key.token },
      effect: key.name,
    });
  }

  constructor(options: ExecutionCancelFencedErrorOptions) {
    const { effect, rootExecutionId, cause } = options;
    super({
      message: `"${effect}" of execution ${rootExecutionId} was refused: its tree's cancel was requested — nothing was written or sent`,
      cause,
    });
    this.scopeKey = options.scopeKey;
    this.tenantId = options.tenantId;
    this.rootExecutionId = rootExecutionId;
    this.leaseExecutionId = options.leaseExecutionId;
    this.token = options.token;
    this.effect = effect;
  }
}
