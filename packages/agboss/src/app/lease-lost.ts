import { AGBossError } from "../core/errors.js";

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
      `the lease of execution ${rootExecutionId} expired and another instance took it: it continues the execution`,
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
  error.message = `the lease of execution ${rootExecutionId} expired before its store confirmed a renewal: this instance stops, another instance continues the execution`;
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
 * scope (`observedToken > token`), so another instance holds the lease now. A hand-over, like the
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
    const observed =
      options.observedToken === undefined
        ? "a newer one"
        : `token ${String(options.observedToken)}`;
    this.message = `a write of lease scope ${options.scopeKey} with token ${String(options.token)} was refused: the external system saw ${observed}, another instance holds the lease and continues the execution`;
  }
}
