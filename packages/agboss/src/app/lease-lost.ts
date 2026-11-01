import { AGBossError } from "../core/errors.js";
import { definedOf } from "../infrastructure/clock.js";
import type { ExecutionLease } from "../infrastructure/execution-lease.repository.js";

/**
 * The instance lost the lease of the tree it was moving (#265, Q58): the lease expired — the holder
 * was frozen or cut off longer than the lease, or its store never confirmed a renewal (#335) — and
 * another instance took it or may take it now, and continues the tree. Not a failure of the
 * execution: it reaches neither `.onError`, `onError` nor the record; only the moving call rejects.
 */
export class ExecutionLeaseLostError extends AGBossError {
  static override readonly code: string = "execution.lease-lost";
  override name = "ExecutionLeaseLostError";
  /**
   * The execution whose lease was lost: the root of the tree, or a `ChildPlacement.AnyInstance`
   * child that holds a lease of its own (#333) — the historic name of `ExecutionLease.rootExecutionId`.
   */
  readonly rootExecutionId: string;

  constructor(rootExecutionId: string) {
    super(
      `the lease of execution ${rootExecutionId} is over — it expired, or another instance took it: this instance stops, the next take of the lease continues the execution`,
    );
    this.rootExecutionId = rootExecutionId;
  }
}

/**
 * The lease ran out without a renewal the store confirmed (#335 S1): no other instance took it
 * yet, so only the message differs — the class, `code` and fields are `ExecutionLeaseLostError`'s.
 */
export function leaseExpiredError(rootExecutionId: string): ExecutionLeaseLostError {
  const error = new ExecutionLeaseLostError(rootExecutionId);
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
  const error = new ExecutionLeaseLostError(rootExecutionId);
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
export interface ExecutionFencedErrorOptions {
  /** `executionContext.fence.scopeKey` of the refused write. */
  readonly scopeKey: string;
  /** The token the refused write carried (`executionContext.fence.token`). */
  readonly token: number;
  /** The highest token the external system saw for the scope, when it says. */
  readonly observedToken?: number | undefined;
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
 * with it, and the tree goes on where the lease is held. `fence.fenced(observedToken)` builds it for
 * the current step; a repository that has only what it wrote builds it from the scope key.
 */
export class ExecutionFencedError extends ExecutionLeaseLostError {
  static override readonly code: string = "execution.lease-lost.fenced";
  override name = "ExecutionFencedError";
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The execution whose lease the write ran under (equals the inherited `rootExecutionId`). */
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly observedToken: number | undefined;

  constructor(options: ExecutionFencedErrorOptions) {
    const scope = scopeOfKey(options.scopeKey);
    if (scope === undefined)
      throw new InvalidScopeKeyError(
        `${JSON.stringify(options.scopeKey)} is not a scope key (executionContext.fence.scopeKey)`,
      );
    super(scope.leaseExecutionId);
    this.scopeKey = options.scopeKey;
    this.tenantId = scope.tenantId;
    this.leaseExecutionId = scope.leaseExecutionId;
    this.token = options.token;
    this.observedToken = options.observedToken;
    this.message = `a write of lease scope ${options.scopeKey} with token ${String(options.token)} was refused: ${fencedReasonOf(options)}`;
  }
}

/**
 * Why a write was fenced, as far as the refusal knows (#567): a newer token seen is a newer take of
 * the lease; the same token or none seen is only a lease that is over — expired, released, or taken
 * by a take the refusing system did not see yet. Never a claim that another instance holds it.
 */
function fencedReasonOf({ token, observedToken }: ExecutionFencedErrorOptions): string {
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
