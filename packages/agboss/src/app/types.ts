import type {
  PauseExecutionOptions,
  PauseOutput,
  StopOptions,
  StopOutput,
  UnpauseExecutionOptions,
} from "./interrupt-types.js";
import type { ThreadStatusTransition } from "../turns/index.js";
import type { Class } from "../components/injection.js";
import type {
  ExecutionInputOf,
  ExecutionOptionsArgs,
  ExecutionOutputOf,
} from "../flow/generated-types.js";
import type { TenantValues } from "../flow/context/context-values.js";
import type { PendingPauseBase } from "../pause/index.js";
import type { PauseClosedReason, PauseKind, PauseStatus } from "../infrastructure/pause-record.js";
import type { ExecutionStreamEvent } from "../run/types.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import type { ExecutionOutput } from "./execution-output.js";
import type { Page, PageQuery } from "./page.js";
import type { TenantContextBranded, TenantListArgs, TenantPointArgs } from "./tenant-args.js";
import type {
  ExecutionHistoryRecord,
  ExecutionHistoryStatus,
} from "../infrastructure/execution-history.repository.js";

export type * from "./execution-output.js";
import type { HealthReport } from "../health/health-check.js";
import type { ExecutionAuditEventRecord } from "../infrastructure/execution-audit-log.repository.js";
import type {
  OutboundCallPage,
  OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";

/**
 * How an execution ended for its caller (#269, Q56, #1341): at a finish (`result.output`,
 * `result.finish`), paused (`result.pending`), stopped (kept as it stood, nothing undone) or
 * cancelled (what it had left undoable was undone). A failure is never a status — the call rejects.
 */
export enum ExecutionStatus {
  Finished = "finished",
  Paused = "paused",
  Stopped = "stopped",
  Cancelled = "cancelled",
}

/** What every leg of an execution takes, `execute` and `resume` alike. */
export interface CallOptions {
  /** Stops the run, like `app.cancel(threadId)`. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Token and tool-call events while the run works. The listener may be `async`; it is not awaited,
   * and one that throws or rejects never fails the run (logged once, `stream.listener-failed`, #1124).
   */
  readonly onStream?: (event: ExecutionStreamEvent) => void;
  /** Extra LangGraph `configurable` keys for the run's nodes (the framework's own keys win). */
  readonly configurable?: Readonly<Record<string, unknown>>;
  /** Also return the full execution record (`result.record`, #270 AC16). */
  readonly includeRecord?: boolean;
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
   * budgets pass: a refused execution creates nothing. A key's text (#538, `KeyTextRule`: 1–200
   * characters, no control or format character, no lone surrogate, NFC), else `InvalidThreadIdError`. Omitted → a new thread with an id of its own.
   */
  readonly threadId?: string | undefined;
  /**
   * Who the thread belongs to (its access key, `executionContext.ownerId`). A new thread is bound
   * to it; continuing, resuming or cancelling a thread with another owner (or none for an owned
   * thread) throws `ThreadOwnerError` before anything runs. A key's text (#589: `keyTextRuleOf`),
   * else `dto.invalid` naming `ownerId` and the rule, never the id.
   */
  readonly ownerId?: string | undefined;
  /**
   * The tenant's values (`ContextValues<T>` of the declared `TenantContext`): with nothing declared
   * `{ tenantId?, weight? }`, omitted → the tenant `"default"`. Validated before the first step
   * (invalid → `dto.invalid`, `onRunRejected`), frozen, inherited by child executions.
   */
  readonly tenant?: TenantValues;
  /** The values of the declared `ExecutionContext` subclass; with the built-in class none. */
  readonly execution?: Readonly<Record<string, unknown>>;
  /**
   * How long the execution may take (#398 PR 2), `seconds(30)`: fixed on the application's `Clock`
   * at its start (a pause counts as time); past it the execution fails with
   * `DeadlineExceededError` (`limit.deadline`) before its next step or model call. A trusted mesh
   * caller's remaining time sets it too — the smaller wins. Omitted → none. At most 24 days (#1141).
   */
  readonly deadline?: Milliseconds;
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
 * (its `answerer` on `@ChannelRole`: the `ownerId` of a thread owner's, the `answeredBy` credential
 * of a channel's — the person who answered). It runs on the context values the execution started with.
 */
export type ResumeOptions = ThreadOwnerResumeOptions | ChannelResumeOptions;

/**
 * Who calls and for which tenant, for what acts on a pause without running anything — `app.extendPause`
 * (#942): the caller fields of `ResumeOptions` and none of `CallOptions` (`signal`, `onStream`, …:
 * nothing executes, so they would be ignored; an object literal with one does not compile). Who may:
 * as an answer — the `ownerId` of a thread owner's pause, the `answeredBy` credential of a channel's.
 */
export type PauseCallerOptions = ThreadOwnerPauseOptions | ChannelPauseOptions;

/** The caller of a `PauseAnswerer.ThreadOwner` pause: checked against the thread's `ownerId`. */
export interface ThreadOwnerPauseOptions {
  readonly tenantId?: string | undefined;
  /** The thread's owner (omitted for a thread without one; another → `ThreadOwnerError`); a key's text (#589). */
  readonly ownerId?: string | undefined;
  readonly answeredBy?: never;
}

/**
 * The caller of a `PauseAnswerer.Channel` pause: the channel's side authenticated who calls; the
 * framework checks only that it is given and is a key's text (#589).
 */
export interface ChannelPauseOptions {
  readonly tenantId?: string | undefined;
  /** Who calls, as the channel's side knows them (`"manager-17"`): non-empty, a key's text (#589). */
  readonly answeredBy: string;
  readonly ownerId?: never;
}

/** The answer of a `PauseAnswerer.ThreadOwner` pause: checked against the thread's `ownerId`. */
export interface ThreadOwnerResumeOptions extends ThreadOwnerPauseOptions, CallOptions {}

/**
 * The answer of a `PauseAnswerer.Channel` pause: the channel's side authenticated who answers; the
 * framework records it (the pause's record, `onExecutionResume`) and checks only that it is given
 * and is a key's text (#589).
 */
export interface ChannelResumeOptions extends ChannelPauseOptions, CallOptions {}

/** What an extension asks. */
export interface ExtendPauseRequest {
  /** The pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /**
   * How long from now the pause waits: its new deadline is `now + expiresIn` (at least `seconds(1)`);
   * `workingHours(8)` counts the pause's calendar (#944): `calendar.add(now, expiresIn)`.
   */
  readonly expiresIn: Milliseconds | WorkingDuration;
}

/** What an extension did: the pause by its key (never its id) and the deadline before and after. */
export interface PauseExtension {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)`. */
  readonly pauseKey: string;
  /** The new deadline (ISO 8601). */
  readonly expiresAt: string;
  /** The deadline it had (ISO 8601). */
  readonly previousExpiresAt: string;
}

/** What a reassignment asks (#946). */
export interface ReassignPauseRequest {
  /** The open pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /**
   * Who the same channel asks now, as the channel reads it (a Slack user, an address, a queue): a key's
   * text (#589), non-empty. The channel's one implementation routes on it.
   */
  readonly assignee: string;
}

/**
 * What a reassignment did: the new pause by its key, never its id — the new id is a capability, it goes
 * to the channel only (`ChannelAsk.pauseId` of the new send) and answers the new pause.
 */
export interface PauseReassignment {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, newPauseId)`. */
  readonly pauseKey: string;
}

/** `app.cancel(threadId, { tenantId, ownerId })`: the thread's tenant and the caller's owner. */
export interface CancelOptions {
  readonly tenantId?: string | undefined;
  /** The caller's owner: a key's text (#589). */
  readonly ownerId?: string | undefined;
  /**
   * Why the thread was cancelled (#1341): kept in its status history (`getStatusHistory`) and
   * reported by the cancelled output and `onExecutionCancel`'s event. Free text, never a key.
   */
  readonly reason?: string | undefined;
}

/**
 * `app.close({ timeout })`: how long the stop takes at most (#265 S51, #367 S3: interrupted a grace
 * before) — default `@Application({ executionLimits: { shutdownTimeout } })`, else `seconds(25)`.
 */
export interface CloseOptions {
  /** How long the stop takes at most (`seconds(0)`: interrupts and stops waiting at once); at most 24 hours — a longer one rejects (#1141). */
  readonly timeout?: Milliseconds;
}

/** What `app.cancel(thread)` did: `cancelled` when the thread had a running or a paused run. */
export interface CancelOutput {
  readonly cancelled: boolean;
}

/**
 * A workflow, built and started: its container, graph (all assembly errors at once) and
 * `onStart` hooks. `execute` starts at a workflow start, `resume` continues a paused thread,
 * `close` runs `onStop` hooks and closes MCP connections.
 */
export interface App<TApp = unknown> {
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
  resume(
    request: ResumeRequest,
    ...options: TenantPointArgs<TApp, ResumeOptions>
  ): Promise<ExecutionOutput>;
  /**
   * Moves an open pause's deadline later (#942): `expiresAt = now + expiresIn`, by whoever may
   * answer it (`answeredBy` for a channel's pause, `ownerId` for its thread owner's, as `resume`).
   * The channel and the listeners hear "extended" and, `remindBefore` before the new deadline,
   * "expiring". Refused: a pause that is closed or past its deadline (`PauseClosedError`), one with
   * no deadline, a deadline not later than the current one, or one past the deadline of the run (or
   * quorum) it was made under (`DtoValidationError`, `dto: "ExtendPauseRequest"`); another tenant's
   * or an unknown pause is `UnknownPauseError`. Atomic at the store against the expiry look; a call
   * that loses the store's compare-and-set to other writers 8 times in a row is
   * `PauseExtensionContendedError` (`pause.update-contended`; nothing changed, retry is safe).
   */
  extendPause(
    request: ExtendPauseRequest,
    ...options: TenantPointArgs<TApp, PauseCallerOptions>
  ): Promise<PauseExtension>;
  /**
   * Moves an open pause to another addressee (#946): the same channel is asked again (`send`) with a
   * new pause id, `ChannelAsk.assignee` and `ChannelAsk.replaces` (the old id), and told
   * `onPauseClosed(Reassigned)` for the old message — in no fixed order. The old id answers nothing any
   * more (`PauseClosedError`, reason `reassigned`); the deadline is kept; the agent and the step do not
   * run again. By whoever may answer the pause (as `extendPause`). Refused: a pause that is closed or past
   * its deadline (`PauseClosedError`, of two reassignments, or a reassignment and an answer, at the same
   * moment exactly one wins), an `assignee` that is no key's text (`DtoValidationError`, `dto:
   * "ReassignPauseRequest"`); another tenant's or an unknown pause is `UnknownPauseError`. The new id
   * is returned to no caller: only its key. The new send is made by this call; when the instance dies
   * first, another instance's timers send it.
   */
  reassignPause(
    request: ReassignPauseRequest,
    ...options: TenantPointArgs<TApp, PauseCallerOptions>
  ): Promise<PauseReassignment>;
  /**
   * Cancels the thread's run: a running one is aborted (`executionContext.signal`; its `execute`
   * resolves with `ExecutionStatus.Cancelled` once what it had undoable is undone — an undo that
   * failed rejects with `ExecutionError.CompensationFailed`), a paused one is dropped (its `resume`
   * throws `NotPausedError`).
   * A thread the tenant does not have → `UnknownThreadError`.
   */
  cancel(threadId: string, ...options: TenantPointArgs<TApp, CancelOptions>): Promise<CancelOutput>;
  /**
   * Stops the thread's execution where it stands (#1341b): what it did is kept and nothing is undone
   * (no `compensateWith` runs — that is `cancel`), and its `execute` / `resume` resolves with
   * `ExecutionStatus.Stopped` (`reason`, the spend, no `finish`). `mode` is `InterruptMode.AfterStep`
   * by default — the step in flight finishes and commits, none starts after it — or `Immediate`:
   * the step in flight is aborted (`executionContext.signal`, `onInterrupted` callbacks awaited) and
   * every new write of the tree is refused. A paused execution is ended at once (its open pauses
   * close as `TreeEnded`). The call returns `{ state }`: `Stopped` (halted before it returned),
   * `Stopping` (durable; its holder winds down) or `NotRunning` (nothing to stop, or already over).
   * Idempotent, and `Cancel > Stop`. A thread the tenant does not have → `UnknownThreadError`.
   */
  stop(threadId: string, ...options: TenantPointArgs<TApp, StopOptions>): Promise<StopOutput>;
  /**
   * Pauses the thread's execution from outside (#1341c): nothing is undone, its checkpoint is kept, and
   * its `execute` / `resume` resolves `ExecutionStatus.Paused` with `isExternallyPaused: true` —
   * until `app.unpause`. `mode` is `InterruptMode.AfterStep` by default (the step in flight finishes
   * and commits, none starts) or `Immediate` (the step in flight is aborted and the tree's token is
   * fenced: its late writes are refused). One that rests at a business pause (`@ExternalTask`,
   * `@ToolApproval`) is `dual_paused`: no answer, deadline or channel decision moves it before
   * `app.unpause` (`app.resume` of an answer → `ExecutionError.ExternallyPaused`). The call returns
   * `{ state }`: `Paused` (frozen before it returned), `Pausing` (durable; its holder parks) or
   * `NotRunning`. Idempotent; `Cancel > Stop > Pause` (a thread being cancelled or stopped →
   * `ExecutionError.AlreadyTerminal`). A thread the tenant does not have → `UnknownThreadError`.
   */
  pause(threadId: string, ...options: TenantPointArgs<TApp, PauseExecutionOptions>): Promise<PauseOutput>;
  /**
   * Lifts `app.pause` (#1341c): a tree parked at a step boundary continues from its last checkpoint
   * (`onExecutionResume`, `ResumeReason.Unpaused`), one at a business pause waits for its answer
   * again — taking at once what was decided or expired while frozen. Waits for a pause that is still
   * parking. A thread not frozen from outside → `PauseError.NotPaused`; one that ended →
   * `ExecutionError.AlreadyTerminal`.
   */
  unpause(
    threadId: string,
    ...options: TenantPointArgs<TApp, UnpauseExecutionOptions>
  ): Promise<ExecutionOutput>;
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
  /**
   * The audit log of one execution tree (#501), oldest first: who took its lease over and which of
   * its steps stopped because it lost it — the rows of `ExecutionAuditLogRepository`, masked like
   * observer events, readable while the tree runs and kept `retention.auditLog`. Another tenant's
   * tree has none.
   */
  auditLogOf(tree: ExecutionTreeQuery): Promise<readonly ExecutionAuditEventRecord[]>;
  /**
   * Every call that left the system from one execution tree (#505), in the order recorded, with
   * its state — the intents of `OutboundCallRepository`, requests masked. Another tenant's tree has
   * none.
   */
  outboundCallsOf(tree: ExecutionTreeQuery): Promise<readonly OutboundCallRecord[]>;
  /**
   * A page of a tenant's calls left pending (#505, #825): what waits for reconciliation, or for an
   * operator — at most `limit` (default 100, at most 1000), from the cursor `after` (a page's
   * `next`), in the order recorded. A call pending for the whole read is listed exactly once.
   */
  pendingOutboundCallsOf(query: PendingOutboundCallsQuery): Promise<OutboundCallPage>;
  /**
   * A page of one tenant's pauses (#943): by `status` (default `Pending`), `role` (the channel's
   * name) and `expiringBefore`, at most `limit` (1 to 1000, default 100), from the cursor `after`
   * (a page's `next`). Pauses come in the order they were made; the cursor is a position in that
   * order, so a pause that opens or closes between two pages never makes another skipped or
   * repeated. A pause's id is shown as `result.pending` shows it (only a `ThreadOwner` pause's),
   * its `pauseKey` always; its `ask` is masked by its workflow's observability policies. Another
   * tenant's pauses are never listed; an invalid query is a `DtoValidationError` (`PausesQuery`).
   */
  listPauses(query: PausesQuery): Promise<PausesPage>;
  /**
   * One kept root execution of a tenant (#1324e), or `undefined` when none is kept under that id
   * (the application keeps its history only with `historyTtl`; another tenant's execution is none).
   * An application that declares a `tenantContext` needs `{ tenantId }`, else it rejects with
   * `ValidationError.TenantRequired` before any store is read.
   */
  getExecution(
    executionId: string,
    ...options: TenantPointArgs<TApp>
  ): Promise<ExecutionHistoryRecord | undefined>;
  /**
   * The status history of a thread (#1341d), oldest change first: one `ThreadStatusTransition` per
   * change of its status — `running`, `paused`, `stopping`, `stopped`, `cancelling`, `cancelled`,
   * `finished`, … — with the `trigger` (`start`, `pause`, `stop`, `cancel`, …), the operator's
   * `reason` and `actor` when a command gave them, and the lease's `leaseToken`. Each row is
   * written in the very transaction of its change (a lease mark, a record's status write), so none
   * is missing or orphaned after a crash. Empty for an unknown thread, another tenant's thread, and
   * a thread whose workflow keeps no history (`historyTtl: Ttl.None`) once its tree has ended.
   * An application that declares a `tenantContext` needs `{ tenantId }`, else it rejects with
   * `ValidationError.TenantRequired`.
   */
  getStatusHistory(
    threadId: string,
    ...options: TenantPointArgs<TApp>
  ): Promise<readonly ThreadStatusTransition[]>;
  /**
   * A page of the kept root executions, oldest start first (#1324e): by `startedAfter` (inclusive) /
   * `startedBefore` (exclusive), `workflow` and `status`, from the cursor of the page before. A
   * page holds at most `limit` records and may hold fewer while a filter drops some: go on while
   * `nextCursor` is there. An application that declares a `tenantContext` needs `{ tenantId }` or
   * `{ allTenants: true }`, else it rejects with `ValidationError.TenantRequired`.
   */
  listExecutions(
    ...query: TenantListArgs<TApp, ExecutionsQuery>
  ): Promise<Page<ExecutionHistoryRecord>>;
  /** Resolves a service or component from the app's internal container. */
  resolve<T>(token: Class<T>): T;
  /** Whether the workflow uses a tool of this name (local, MCP or knowledge-base search). */
  hasTool(name: string): boolean;
}

/** Which executions `app.listExecutions` reads (#1324e); the tenant is its scope, named per its application. */
export interface ExecutionsQuery extends PageQuery {
  /** Only those started at or after it (`Date`, or an ISO 8601 text). */
  readonly startedAfter?: Date | string;
  /** Only those started before it (`Date`, or an ISO 8601 text). */
  readonly startedBefore?: Date | string;
  /** Only the executions of the workflow of this name. */
  readonly workflow?: string;
  /** Only those with this status (several: any of them). */
  readonly status?: ExecutionHistoryStatus | readonly ExecutionHistoryStatus[];
}

/** Which pending calls `app.pendingOutboundCallsOf` reads (#825): a tenant's, a page of them. */
export interface PendingOutboundCallsQuery {
  readonly tenantId: string;
  /** How many at most: a whole number from 1 to 1000; default 100. */
  readonly limit?: number;
  /** The `next` of the page before; none → from the first. */
  readonly after?: string;
}

/** Which pauses `app.listPauses` reads (#943): a tenant's, a page of them. */
export interface PausesQuery {
  readonly tenantId: string;
  /** Default `Pending`; several: any of them. */
  readonly status?: PauseStatus | readonly PauseStatus[];
  /** The channel's name (a role's, or a concrete channel's). */
  readonly role?: string;
  /** Only pauses whose deadline is before it; one with no deadline is never listed. */
  readonly expiringBefore?: Date;
  /** How many at most: a whole number from 1 to 1000; default 100. */
  readonly limit?: number;
  /** The `next` of the page before; none → from the first. */
  readonly after?: string;
}

/** One pause as `app.listPauses` shows it: `pauseId` per the rule of `result.pending`, `pauseKey` always. */
export interface ListedPause extends Omit<PendingPauseBase, "answeredBy"> {
  readonly kind: PauseKind;
  /** The question, masked by the pause's workflow's observability policies. */
  readonly ask: unknown;
  /** Who answered a closed pause (`undefined` while open, or when its channel decided). */
  readonly answeredBy?: string;
  /** The pause's one-way key: what a metric, a log or an error calls it in place of its id. */
  readonly pauseKey: string;
  readonly status: PauseStatus;
  readonly rootExecutionId: string;
  readonly threadId: string;
  readonly askedAt: string;
  readonly expiresAt?: string;
  /** Why a closed pause closed. */
  readonly reason?: PauseClosedReason;
  readonly closedAt?: string;
}

/** A page of `app.listPauses`; `next` is the cursor of the page after it, absent on the last. */
export interface PausesPage {
  readonly pauses: readonly ListedPause[];
  readonly next?: string;
}

/** Which tree `app.auditLogOf` and `app.outboundCallsOf` read: the tenant's root execution. */
export interface ExecutionTreeQuery {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}

/**
 * An app whose types ask for no tenant, as the testing toolkit and the transports hold it: a call that
 * needs a tenant may omit it for the compiler — an application that declares a `tenantContext` still
 * refuses it at run time (`ValidationError.TenantRequired`). `createApp` returns the stricter
 * `App<InstanceType<TApplication>>`.
 */
export type AnyTenantApp = App<TenantContextBranded<false>>;

/**
 * One workflow of an application at run time (internal): the app without the instance's probes and
 * audit log.
 */
export type WorkflowApp = Omit<
  AnyTenantApp,
  | "getExecution"
  | "getStatusHistory"
  | "listExecutions"
  | "checkLiveness"
  | "checkReadiness"
  | "auditLogOf"
  | "outboundCallsOf"
  | "pendingOutboundCallsOf"
  | "listPauses"
>;
