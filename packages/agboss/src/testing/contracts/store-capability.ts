/**
 * What a store declares it can do beyond its contract's required methods (#831): an optional
 * method its contract's cases check only when the store says it has it. A declared capability must
 * pass its cases; one not declared is skipped, with the reason, on a store that lacks it; a store
 * that has the method but does not declare it fails them — the suite reads what the store claims,
 * never guesses it from the store's shape.
 */
export enum StoreCapability {
  /**
   * `ChildExecutionQueueRepository.watchQueued` (#777): the store wakes an instance when any
   * instance queues a child. Without it a child queued elsewhere waits for the 30 s sweep.
   */
  WatchQueued = "watchQueued",
}

const CAPABILITIES: ReadonlySet<string> = new Set(Object.values(StoreCapability));

/** Whether `value` is one of `StoreCapability`'s values. */
export const isStoreCapability = (value: unknown): value is StoreCapability =>
  typeof value === "string" && CAPABILITIES.has(value);
