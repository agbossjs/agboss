import { ExecutionError } from "../core/error-families/run-errors.js";
import { AGBossError } from "../core/errors.js";
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
 * execution: it reaches neither `.onError` nor the record; only the moving call rejects.
 */
export class ExecutionLeaseLostError extends AGBossError {
  static override readonly code: string = "execution.lease-lost";
  /** This class's code, or its subclass `ExecutionFencedError`'s (#906: `switch (error.code)` narrows). */
  declare readonly code:
    "execution.lease-lost" | "execution.lease-lost.fenced" | "execution.lease-lost.not-started";
  override name = "ExecutionLeaseLostError";
  /**
   * The execution whose lease was lost: the root of the tree, or a `ChildPlacement.AnyWorker`
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
 * The lease was lost before the run wrote its first checkpoint (#1090): nothing is stored, so the
 * next take has nothing to continue — it ends the run's record as failed (`NothingToRecoverError`).
 * The same class, fields and `cause` as `lost`; its `code` is `execution.lease-lost.not-started` and its message says that the run did not start.
 */
export function leaseLostBeforeStartError(
  lost: Pick<ExecutionLeaseLostError, "rootExecutionId" | "cause">,
): ExecutionLeaseLostError {
  const error = new ExecutionLeaseLostError({
    rootExecutionId: lost.rootExecutionId,
    cause: lost.cause,
  });
  // a code of its own (#906): a caller tells it from a lease lost in the middle of a run
  Object.defineProperty(error, "code", { value: "execution.lease-lost.not-started" });
  error.message = `the lease of execution ${lost.rootExecutionId} was lost before the run stored its first checkpoint: the run did not start, nothing is left for the next take to continue (its record ends failed) — start it again`;
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

/** `decodeURIComponent(text)`; `null` for a text with a malformed escape. */
const decodedOf = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** The tenant and execution of a scope key; `undefined` for a text that is not one. */
export function scopeOfKey(
  scopeKey: string,
): { readonly tenantId: string; readonly leaseExecutionId: string } | undefined {
  const parts = scopeKey.split(":");
  if (parts.length !== 2) return undefined;
  const [tenant, execution] = parts as [string, string];
  const tenantId = decodedOf(tenant);
  const leaseExecutionId = decodedOf(execution);
  if (tenantId === null || leaseExecutionId === null) return undefined;
  return { tenantId, leaseExecutionId };
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

class InvalidScopeKeyError extends TypeError {
  override name = "InvalidScopeKeyError";
}

/**
 * The refusal of a write that knows only its scope key and tokens — a repository's (#890): the
 * `ExecutionError.Fenced` of a hand-over (#471). The key is read into its tenant and execution; one
 * that is no scope key (`<tenant>:<execution>`, each URI-encoded) is a `TypeError` here, where the
 * store builds it. `fence.fencedError(observedToken)` builds the same for the current step. The
 * token seen newer is a newer take of the lease; the same token or none is only a lease that is
 * over (#567) — a hand-over either way: no `.onError`, no compensation, no failed record, the moving
 * call rejects with it and the tree goes on where the lease is held.
 */
export function fencedRefusalOf(refusal: FencedWriteRefusal): ExecutionError.Fenced {
  const scope = scopeOfKey(refusal.scopeKey);
  if (scope === undefined)
    throw new InvalidScopeKeyError(
      `${JSON.stringify(refusal.scopeKey)} is not a scope key (executionContext.fence.scopeKey)`,
    );
  const { scopeKey, token, observedToken, cause } = refusal;
  return new ExecutionError.Fenced({
    message: `a write of lease scope ${scopeKey} with token ${String(token)} was refused: ${fencedReasonOf(refusal)}`,
    scopeKey,
    token,
    observedToken,
    ...scope,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Why a write was fenced, as far as the refusal knows (#567): a newer token seen is a newer take of
 * the lease; the same token or none seen is only a lease that is over — expired, released, or taken
 * by a take the refusing system did not see yet. Never a claim that another instance holds it.
 */
function fencedReasonOf({ token, observedToken }: FencedWriteRefusal): string {
  if ((observedToken ?? Number.NEGATIVE_INFINITY) > token)
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
