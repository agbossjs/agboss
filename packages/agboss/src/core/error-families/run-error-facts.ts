/** The facts of `ExecutionError.CancelFenced`: the write its tree's cancel refused. */
export interface CancelFencedFacts {
  /** `executionContext.fence.scopeKey` of the refused write. */
  readonly scopeKey?: string | undefined;
  readonly tenantId?: string | undefined;
  /** The root of the tree whose cancel refused it. */
  readonly rootExecutionId?: string | undefined;
  /** The execution whose lease the write ran under (the root, or an `AnyWorker` child). */
  readonly leaseExecutionId?: string | undefined;
  readonly token?: number | undefined;
  /** The effect's or the call's name, never its business key. */
  readonly effect?: string | undefined;
}
