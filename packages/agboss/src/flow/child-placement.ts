import { minutes, type Milliseconds } from "../units/index.js";

/**
 * Where a child workflow runs (#333 PR 2, ADR-0022, #1286): declared on the child's `@Workflow({
 * placement })`, else the application's `defaults.workflows.placement`, else `CurrentProcess`.
 * Never on the flow: the same graph runs in one process in dev and on a cluster in production.
 */
export enum ChildPlacement {
  /** In the current Node.js process, inside the parent's step, with no queue hop (the default). */
  CurrentProcess = "current-process",
  /** Queued in `ChildExecutionQueueRepository`; claimed by any live worker with a free slot. */
  AnyWorker = "any-worker",
  /** Queued; claimed only by a live worker other than the one that launched it. */
  OtherWorker = "other-worker",
  /** A fresh isolated Node.js process of its own, exiting when the child ends (#1286b). */
  IsolatedWorker = "isolated-worker",
}

const PLACEMENTS: ReadonlySet<unknown> = new Set(Object.values(ChildPlacement));

/** Whether `value` is a placement (untyped code may pass anything). */
export const isChildPlacement = (value: unknown): value is ChildPlacement => PLACEMENTS.has(value);

/** Whether a child with this placement goes through `ChildExecutionQueueRepository`. */
export const isQueued = (placement: ChildPlacement | undefined): boolean =>
  placement !== undefined && placement !== ChildPlacement.CurrentProcess;

/** How long an `OtherWorker` child waits for a worker other than its launcher before its parent fails (#1286, D9). */
export const CHILD_CLAIM_TIMEOUT: Milliseconds = minutes(1);
