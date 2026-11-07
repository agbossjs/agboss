import type { ExecutionIdentity } from "../infrastructure/execution-lease.repository.js";
import type { PendingPause } from "../pause/types.js";
import type { App } from "./types.js";

/**
 * What a transport that runs executions under ids of its own (#807: A2A tasks, design §4.1.5,
 * §4.3.2) may do to one execution tree, from any instance (internal, `@agboss/core/internal`):
 * cancel it by its root execution id — never its thread's other runs —, read where it is from the
 * durable records (what an observer event missed), and fence a reserved id no execution started
 * under.
 */

/** One root execution of an application: its tenant, its id and its thread. */
export interface ExecutionTreeOfThread {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly threadId: string;
}

/** A cancel of one execution tree: who asks (`ownerId`, kept with the request). */
export interface ExecutionCancelRequest extends ExecutionTreeOfThread {
  readonly ownerId?: string | undefined;
}

/** What `cancelExecution` found and did; in every case the request is kept until the tree ends. */
export enum ExecutionCancelOutcome {
  /** It ran on this instance: its signal aborted, it rejects with `ExecutionCancelledError`. */
  Aborted = "aborted",
  /** It rested paused: ended here as cancelled (its pauses withdrawn, its undo run). */
  Ended = "ended",
  /** It runs on another instance: its holder stops within one lease renewal (or recovery ends it). */
  Requested = "requested",
  /** It has not started: the request stops it before its first step when it does. */
  AwaitingStart = "awaiting-start",
  /** It had ended already: nothing to cancel, the request withdrawn. */
  AlreadyOver = "already-over",
}

/** Where an execution tree is, as its durable records say. */
export enum DurableExecutionStatus {
  /** No record, no checkpoint, no paused run: it has not started (or never will). */
  NotStarted = "not-started",
  /** Its record runs (or a checkpoint shows it began): a holder moves it, or recovery will. */
  Running = "running",
  /** It rests paused. */
  Paused = "paused",
  /** It reached a finish. */
  Finished = "finished",
  /** It failed (its record's reason). */
  Failed = "failed",
  /** It was cancelled. */
  Cancelled = "cancelled",
}

export type DurableExecutionState =
  | { readonly status: DurableExecutionStatus.NotStarted }
  | { readonly status: DurableExecutionStatus.Running }
  | { readonly status: DurableExecutionStatus.Paused; readonly pending: readonly PendingPause[] }
  | {
      readonly status: DurableExecutionStatus.Finished;
      readonly finish: string;
      readonly output: unknown;
      /**
       * What the tree spent (#844): its record's cost — the spend its end event reports, its
       * strategies' memory update included — else its last checkpoint's, so a status repaired from
       * the records still signs its run report.
       */
      readonly spentUsd: number;
    }
  | { readonly status: DurableExecutionStatus.Failed; readonly reason: string }
  | { readonly status: DurableExecutionStatus.Cancelled };

/** What a workflow's app does to one of its trees. */
export interface WorkflowExecutionControl {
  cancelExecution(request: ExecutionCancelRequest): Promise<ExecutionCancelOutcome>;
  executionStateOf(tree: ExecutionTreeOfThread): Promise<DurableExecutionState>;
}

/** What an application instance does to one of its trees. */
export interface ExecutionControl extends WorkflowExecutionControl {
  /**
   * Keeps a reserved id now, so that no execution can ever start under it: `true` when this call
   * kept it, `false` when an execution (or another fence) kept it first.
   */
  claimExecutionId(identity: ExecutionIdentity): Promise<boolean>;
}

const controls = new WeakMap<object, ExecutionControl>();

/** Remembers an instance's control by its app (and by its infrastructure, for its own observers). */
export const rememberExecutionControl = (
  instance: Pick<App, "execute"> | object,
  control: ExecutionControl,
): void => {
  controls.set(instance, control);
};

/**
 * The execution control of an app, or of an instance by its infrastructure; one not built by
 * `createApp` (a test double) has none.
 */
export const executionControlOf = (
  instance: Pick<App, "execute"> | object,
): ExecutionControl | undefined => controls.get(instance);
