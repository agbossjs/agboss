import type { CompensationRecord } from "../flow/compensation.js";
import type { LaunchRecord } from "../flow/runtime/launch/records.js";
import type { ChildExecutionRecord, HandledErrorRecord } from "../flow/runtime/child-records.js";
import type { Class } from "../components/injection.js";
import type { CostReport } from "../finops/usage.js";
import type {
  ExecutionInputOf,
  ExecutionOptionsArgs,
  ExecutionOutputOf,
} from "../flow/generated-types.js";
import type { ContextFields, TenantValues } from "../flow/context/context-values.js";
import type { ExecutionRecord } from "../flow/runtime/execution-record.js";
import type { ToolCallRecord } from "../flow/runtime/tool-calls.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { PendingPause } from "../pause/index.js";
import type { Compacted } from "../run/compaction.js";
import type { ExecutionStreamEvent } from "../run/types.js";
import type { Milliseconds } from "../units/index.js";
import type { HealthReport } from "../health/health-check.js";

/**
 * How an execution ended for its caller (#269, Q56): at a finish (`result.output`, `result.finish`)
 * or paused (`result.pending`). A failure is never a status — the call rejects.
 */
export enum ExecutionStatus {
  Finished = "finished",
  Paused = "paused",
}

/** What every leg of an execution takes, `execute` and `resume` alike. */
export interface CallOptions {
  /** Stops the run, like `app.cancel(threadId)`. */
  readonly signal?: AbortSignal | undefined;
  /** Token and tool-call events while the run works. */
  readonly onStream?: (event: ExecutionStreamEvent) => void;
  /** Extra LangGraph `configurable` keys for the run's nodes (the framework's own keys win). */
  readonly configurable?: Readonly<Record<string, unknown>>;
  /** Also return the full execution record (`result.record`, #270 AC16). */
  readonly record?: boolean;
}

/**
 * `app.execute(Start, input, options)` (#261): named like the `ExecutionContext` fields they fill —
 * the conversation to continue (`threadId`, omit for a new one), its owner, and the values of the
 * execution's contexts, typed per start by the generated `.agboss/types.d.ts`.
 */
export interface ExecutionOptions extends CallOptions {
  /**
   * The thread, in the execution's tenant (its key: tenant + thread): one it has is continued; an
   * id it does not have yet is created as the caller's own new thread (#262 Q4) — an idempotent id
   * the caller picked; the same id in another tenant is another thread. Created only once the
   * budgets pass: a refused execution creates nothing. 1–200 characters, no control characters,
   * else `InvalidThreadIdError`. Omitted → a new thread with an id of its own.
   */
  readonly threadId?: string | undefined;
  /**
   * Who the thread belongs to (its access key, `executionContext.ownerId`). A new thread is bound
   * to it; continuing, resuming or cancelling a thread with another owner (or none for an owned
   * thread) throws `ThreadOwnerError` before anything runs.
   */
  readonly ownerId?: string | undefined;
  /**
   * The tenant's values (`ContextValues<T>` of the declared `TenantContext`): with nothing declared
   * `{ tenantId?, weight? }`, omitted → the tenant `"default"`. Validated before the first step
   * (invalid → `dto.invalid`, `onRunRejected`), frozen, inherited by child executions.
   */
  readonly tenant?: TenantValues;
  /** The values of the declared `ExecutionContext` subclass; with the built-in class none. */
  readonly execution?: ContextFields;
}

/**
 * What `app.resume` answers (#267): one pause, by its id — found anywhere in its execution tree —
 * and the decision for it, validated against its channel role's answer DTO (a tool approval: a
 * `ToolCallApprovalDecisionDto`).
 */
/**
 * What `app.resume` answers a pause with (#267): its id and exactly one of a typed `decision` or a
 * free-text `reply` — read by the pause's role's `@ReplyInterpreter`, the pause staying pending when
 * it cannot be read (`UninterpretableReplyError`).
 */
export type ResumeRequest = DecisionResumeRequest | ReplyResumeRequest;

/** A pause answered with its decision. */
export interface DecisionResumeRequest {
  /** The pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /** The answer, checked against the pause's role (a tool approval: a `ToolCallApprovalDecisionDto`). */
  readonly decision: unknown;
  readonly reply?: never;
}

/** A pause answered with a free-text reply, as a webhook got it (`"ok, but only half"`). */
export interface ReplyResumeRequest {
  /** The pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /** The reply as it came, non-empty: its role's interpreter reads it with the pause's question. */
  readonly reply: string;
  readonly decision?: never;
}

/**
 * `app.resume(request, options)`: a resume finds what exists, so it takes keys and credentials only
 * — the tenant by its id (omitted → `"default"`) and who answers, as the pause's role says
 * (`answeredBy` on `@ChannelRole`). It runs on the context values the execution started with.
 */
export type ResumeOptions = ThreadOwnerResumeOptions | ChannelResumeOptions;

/** The answer of a `PauseAnswerer.ThreadOwner` pause: checked against the thread's `ownerId`. */
export interface ThreadOwnerResumeOptions extends CallOptions {
  readonly tenantId?: string | undefined;
  /** The thread's owner (omitted for a thread without one; another → `ThreadOwnerError`). */
  readonly ownerId?: string | undefined;
  readonly answeredBy?: never;
}

/**
 * The answer of a `PauseAnswerer.Channel` pause: the channel's side authenticated who answers; the
 * framework records it (the pause's record, `onExecutionResume`) and checks only that it is given.
 */
export interface ChannelResumeOptions extends CallOptions {
  readonly tenantId?: string | undefined;
  /** Who answered, as the channel's side knows them (`"manager-17"`): non-empty. */
  readonly answeredBy: string;
  readonly ownerId?: never;
}

/** `app.cancel(threadId, { tenantId, ownerId })`: the thread's tenant and the caller's owner. */
export interface CancelOptions {
  readonly tenantId?: string | undefined;
  readonly ownerId?: string | undefined;
}

/**
 * `app.close({ timeout })`: how long the stop takes at most (#265 S51, #367 S3: interrupted a grace
 * before) — default `@Application({ shutdownTimeout })`, else `seconds(25)`.
 */
export interface CloseOptions {
  /** How long the stop takes at most (`seconds(0)`: interrupts and stops waiting at once). */
  readonly timeout?: Milliseconds;
}

/** What `app.cancel(thread)` did: `cancelled` when the thread had a running or a paused run. */
export interface CancelOutput {
  readonly cancelled: boolean;
}

/**
 * What one execution (or resume) of the app ended with: `output` and `finish` when it reached a
 * workflow finish, `pending` when it waits for answers; `path` = the node ids it visited, `spend`
 * = its cost; `record` only with `{ record: true }`.
 */
export interface ExecutionOutput<TOutput = unknown> {
  readonly status: ExecutionStatus;
  /** The execution's thread: `options.threadId` to continue it. */
  readonly threadId: string;
  /** The tenant of the thread (#261): `"default"` when the execution named none. */
  readonly tenantId: string;
  /**
   * The execution's id: the same in its observer events, `executionContext.executionId`, its
   * record and its trace, and kept by its resumes.
   */
  readonly executionId: string;
  /** The workflow finish the execution reached. */
  readonly finish?: ComponentRecord;
  /** The finish's output DTO — the business result only. */
  readonly output?: TOutput;
  /**
   * Every pause the execution waits for (#267 AC1) — several when parallel branches each wait;
   * empty unless `status` is `Paused`. A `PauseAnswerer.Channel` pause comes without its `pauseId`.
   */
  readonly pending: readonly PendingPause[];
  /** Node ids (component names) in the order the execution visited them. */
  readonly path: readonly string[];
  readonly spend: CostReport;
  /**
   * Its parallel launches (#273), in the order they joined: each one's id, how many items (or
   * listed targets) there were and were launched — `{ items: 200, taken: 50 }` after `maxItems` —
   * and how each branch ended.
   */
  readonly launches: readonly LaunchRecord[];
  /**
   * Its child executions that ended (#263), in the order they ended: each one's id, workflow, item,
   * start, how it ended (`ChildExecutionStatus`), its finish or error, its own spend and its own
   * children — nested records, never in the thread's conversation history.
   */
  readonly children: readonly ChildExecutionRecord[];
  /** The failures an `.onError` / `.onJoinError` side path took, in order (`toHaveHandledError`). */
  readonly handledErrors: readonly HandledErrorRecord[];
  /**
   * The undo actions that ran (#340), in the order they ended: on a side path
   * (`CompensationReason.SidePath`) or automatically — a failed join's finished branches
   * (`JoinFailed`) — each with the step it undid, how it ended and when (`toHaveCompensated`).
   */
  readonly compensations: readonly CompensationRecord[];
  /**
   * Its own agents' tool calls (#395), in call order — each with its step (the tool and the agent's
   * visit), input, output, `ToolCallStatus`, error and times; a child's are in `result.children`.
   * Real values, like `output`; `result.record.toolCalls` holds them masked.
   */
  readonly toolCalls: readonly ToolCallRecord[];
  /** What the compactions did before this execution read its thread (#120 S132), when one did. */
  readonly compacted?: readonly Compacted[];
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
    ...options: ExecutionOptionsArgs<InstanceType<TStart>>
  ): Promise<ExecutionOutput<ExecutionOutputOf<InstanceType<TStart>>>>;
  /**
   * Answers one pause (#267): found by `(options.tenantId, request.pauseId)` anywhere in its
   * execution tree (unknown, or another tenant's → `UnknownPauseError`), checked against who may
   * answer it, its decision validated, then recorded (`Pending → Resolved`, atomic; a second
   * answer → `NotPausedError`) and the tree moved under its lease. With other pauses left the
   * execution pauses again with the rest. The result carries `threadId` and `executionId`.
   */
  resume(request: ResumeRequest, options?: ResumeOptions): Promise<ExecutionOutput>;
  /**
   * Cancels the thread's run: a running one is aborted (`executionContext.signal`; its `execute` rejects
   * with `ExecutionCancelledError`), a paused one is dropped (its `resume` throws `NotPausedError`).
   * A thread the tenant does not have → `UnknownThreadError`.
   */
  cancel(threadId: string, options?: CancelOptions): Promise<CancelOutput>;
  /**
   * Stops the app within the shutdown timeout (#261, #265, #367): no new executions, `onStop`, the
   * running ones awaited — interrupted a grace before its end, staying `running` for another instance —
   * the step bodies they left awaited in the grace, then `onDestroy`. A shorter `timeout` ends sooner.
   */
  close(options?: CloseOptions): Promise<void>;
  /**
   * The liveness probe (#300): no network, no database — the instance (`Unhealthy`, `stopping`,
   * from `close()` on) and its recovery loop (`Unhealthy` when its last sweep is older than three
   * sweep intervals). Never rejects.
   */
  checkLiveness(): Promise<HealthReport>;
  /**
   * The readiness probe (#300): liveness's components, every store's `ping()`, every model
   * provider's circuit breaker (open → `Degraded`, never a model call) and every
   * `@Application({ healthChecks })` check — at once, each under its timeout on the `Clock`. A check
   * that throws or times out is `Unhealthy` with its reason; the call never rejects.
   */
  checkReadiness(): Promise<HealthReport>;
  /** Resolves a service or component from the app's internal container. */
  resolve<T>(token: Class<T>): T;
  /** Whether the workflow uses a tool of this name (local, MCP or knowledge-base search). */
  hasTool(name: string): boolean;
}

/** One workflow of an application at run time (internal): the app without the instance's probes. */
export type WorkflowApp = Omit<App, "checkLiveness" | "checkReadiness">;
