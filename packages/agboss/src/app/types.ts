import type { LaunchRecord } from "../flow/runtime/launch/records.js";
import type { Class } from "../components/injection.js";
import type { CostReport } from "../finops/usage.js";
import type { ExecutionInputOf, ExecutionOutputOf } from "../flow/generated-types.js";
import type { ExecutionRecord } from "../flow/runtime/execution-record.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { PendingPause } from "../pause/index.js";
import type { Compacted } from "../run/compaction.js";
import type { RunStreamEvent } from "../run/types.js";
import type { Milliseconds } from "../units/index.js";

/**
 * How an execution ended for its caller (#269, Q56): at a finish (`result.output`, `result.finish`)
 * or paused (`result.pause`). A failure is never a status — the call rejects.
 */
export enum ExecutionStatus {
  Finished = "finished",
  Paused = "paused",
}

/** Per call: the conversation to continue (omit for a new one) and what the run carries. */
export interface ExecutionOptions {
  readonly thread?: string;
  /** Stops the run, like `app.cancel(thread)`. */
  readonly signal?: AbortSignal | undefined;
  /** Token and tool-call events while the run works. */
  readonly onStream?: (event: RunStreamEvent) => void;
  /**
   * The caller's own value for channels and guardrails (`ChannelRequest.executionContext`) — not
   * the injected `ExecutionContext`; #261 replaces it with typed `execution: { … }` values.
   */
  readonly executionContext?: unknown;
  /**
   * Who the thread belongs to (a user, a tenant). A new thread is bound to it; continuing,
   * resuming or cancelling a thread with another owner (or none for an owned thread) throws
   * `ThreadOwnerError` before anything runs. Read as `executionContext.ownerId`.
   */
  readonly owner?: string | undefined;
  /** For channels (`ChannelRequest.metadata`); a resume keeps it unless it passes its own. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Extra LangGraph `configurable` keys for the run's nodes (the framework's own keys win). */
  readonly configurable?: Readonly<Record<string, unknown>>;
  /** Also return the full execution record (`result.record`, #270 AC16). */
  readonly record?: boolean;
}

/** `app.cancel(thread, { owner })`: the caller's owner, checked like `execute`'s. */
export interface CancelOptions {
  readonly owner?: string | undefined;
}

/**
 * `app.close({ timeout })`: how long the stop waits for the running executions before it
 * interrupts them (#265 S51) — default `@Application({ shutdownTimeout })`, else `seconds(25)`.
 */
export interface CloseOptions {
  /** How long to wait before interrupting (`seconds(0)`: at once). */
  readonly timeout?: Milliseconds;
}

/** What `app.cancel(thread)` did: `cancelled` when the thread had a running or a paused run. */
export interface CancelOutput {
  readonly cancelled: boolean;
}

/**
 * What one execution (or resume) of the app ended with: `output` and `finish` when it reached a
 * workflow finish, `pause` when it waits for an approval; `path` = the node ids it visited, `spend`
 * = its cost; `record` only with `{ record: true }`.
 */
export interface ExecutionOutput<TOutput = unknown> {
  readonly status: ExecutionStatus;
  readonly thread: string;
  /**
   * The run's id: the same in its observer events, `executionContext.executionId`, its Tern and its trace, and
   * kept by its resumes.
   */
  readonly runId: string;
  /** The workflow finish the execution reached. */
  readonly finish?: ComponentRecord;
  /** The finish's output DTO — the business result only. */
  readonly output?: TOutput;
  /** What the run waits for (until #267: the tool call waiting for approval). */
  readonly pause?: PendingPause;
  /** Node ids (component names) in the order the execution visited them. */
  readonly path: readonly string[];
  readonly spend: CostReport;
  /**
   * Its parallel launches (#273), in the order they joined: each one's id, how many items (or
   * listed targets) there were and were launched — `{ items: 200, taken: 50 }` after `maxItems` —
   * and how each branch ended.
   */
  readonly launches: readonly LaunchRecord[];
  /** Conversation memory: what this turn compacted, when it did. */
  readonly compacted?: Compacted;
  /** The conversation in the tracing UI (session = thread), when tracing is on. */
  readonly traceUrl?: string;
  /** The full execution record, with `app.execute(…, { record: true })`. */
  readonly record?: ExecutionRecord;
}

/**
 * A workflow, built and started: its container, graph (all assembly errors at once) and
 * `onStart` hooks. `execute` starts at a workflow start, `resume` continues a paused thread,
 * `close` runs `onStop` hooks and closes MCP connections.
 */
export interface App {
  readonly name: string;
  readonly version: string;
  /** Startup warnings, e.g. a config changed without a version bump. */
  readonly warnings: readonly string[];
  /** One line per model use: its provider, reasoning and caching (the startup log). */
  readonly models: readonly string[];
  /** The workflow start a plain text goes to (input `WorkflowStartTextDto`), if the graph has one. */
  readonly textStart: Class | undefined;
  /**
   * Runs the workflow from a `@WorkflowStart` class; `input` is typed by the generated
   * `.agboss/types.d.ts` (`agboss check`) and checked against the start's `input` at run time.
   */
  execute<TStart extends Class>(
    start: TStart,
    input: ExecutionInputOf<InstanceType<TStart>>,
    options?: ExecutionOptions,
  ): Promise<ExecutionOutput<ExecutionOutputOf<InstanceType<TStart>>>>;
  resume(
    thread: string,
    decision: unknown,
    options?: Omit<ExecutionOptions, "thread">,
  ): Promise<ExecutionOutput>;
  /**
   * Cancels the thread's run: a running one is aborted (`executionContext.signal`; its `execute` rejects
   * with `WorkflowCancelledError`), a paused one is dropped (its `resume` throws `NotPausedError`).
   */
  cancel(thread: string, options?: CancelOptions): Promise<CancelOutput>;
  /**
   * Stops the app (#261, #265): no new executions, `onStop`, the running ones awaited up to the
   * shutdown timeout — then interrupted, each releasing its lease and staying `running`, so another
   * instance continues it — then `onDestroy`. A second call with a shorter `timeout` shortens the wait.
   */
  close(options?: CloseOptions): Promise<void>;
  /** Resolves a service or component from the app's internal container. */
  resolve<T>(token: Class<T>): T;
  /** Whether the workflow uses a tool of this name (local, MCP or knowledge-base search). */
  hasTool(name: string): boolean;
}
