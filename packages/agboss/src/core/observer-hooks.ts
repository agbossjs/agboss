import type { Class } from "../components/injection.js";
import type { ExecutionOutput } from "../app/types.js";
import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
import type {
  ActionEndEvent,
  ActionStartEvent,
  AgentEndEvent,
  AgentStartEvent,
  AppState,
  ChannelEndEvent,
  ChannelStartEvent,
  GuardrailEndEvent,
  GuardrailStartEvent,
  JudgeEndEvent,
  JudgeStartEvent,
  ModelEndEvent,
  ModelStartEvent,
  PiiPolicyEndEvent,
  PiiPolicyStartEvent,
  RagEndEvent,
  RagStartEvent,
  RouterEndEvent,
  RouterStartEvent,
  RunRejectedEvent,
  ToolEndEvent,
  ToolStartEvent,
  WorkflowPauseEvent,
  WorkflowResumeEvent,
} from "./observability.js";

/** What a hook may return: it is awaited, its value is ignored. */
type HookResult = Promise<void> | void;

/**
 * Observer hooks, one interface per hook. An observer class implements any of them and is listed
 * in `@Workflow({ observers: [...] })`; only listed classes are called.
 */
/** Once per run, at `execute` (a resume does not start it again). */
export interface OnWorkflowStart {
  onWorkflowStart(state: AppState): HookResult;
}
/** The run paused (an approval, a channel); `onWorkflowResume` follows when it is resumed. */
export interface OnWorkflowPause {
  onWorkflowPause(event: WorkflowPauseEvent): HookResult;
}
/** `app.resume` picked the paused run up. */
export interface OnWorkflowResume {
  onWorkflowResume(event: WorkflowResumeEvent): HookResult;
}
/**
 * A request was refused before a run started or was located (`execute`, `resume` or `cancel` of
 * another owner's thread, a resume with nothing paused, an unknown thread, an invalid start input).
 */
export interface OnRunRejected {
  onRunRejected(event: RunRejectedEvent): HookResult;
}
/** The run finished — at `execute`, or after a resume. */
export interface OnWorkflowEnd {
  onWorkflowEnd(result: ExecutionOutput, state: AppState): HookResult;
}
export interface OnAgentStart {
  onAgentStart(event: AgentStartEvent): HookResult;
}
export interface OnAgentEnd {
  onAgentEnd(event: AgentEndEvent): HookResult;
}
export interface OnRouterStart {
  onRouterStart(event: RouterStartEvent): HookResult;
}
export interface OnRouterEnd {
  onRouterEnd(event: RouterEndEvent): HookResult;
}
export interface OnToolStart {
  onToolStart(event: ToolStartEvent): HookResult;
}
export interface OnToolEnd {
  onToolEnd(event: ToolEndEvent): HookResult;
}
/** Every model call of an agent. */
export interface OnModelStart {
  onModelStart(event: ModelStartEvent): HookResult;
}
export interface OnModelEnd {
  onModelEnd(event: ModelEndEvent): HookResult;
}
export interface OnRagStart {
  onRagStart(event: RagStartEvent): HookResult;
}
export interface OnRagEnd {
  onRagEnd(event: RagEndEvent): HookResult;
}
/**
 * A run failed (also after a resume, or cancelled while paused: `WorkflowCancelledError`), a resume
 * of a paused run was refused as incompatible (`IncompatibleResumeError`; the run stays paused), or
 * an optional branch failed and was skipped.
 */
export interface OnError {
  onError(error: Error, state: AppState): HookResult;
}
export interface OnGuardrailStart {
  onGuardrailStart(event: GuardrailStartEvent): HookResult;
}
export interface OnGuardrailEnd {
  onGuardrailEnd(event: GuardrailEndEvent): HookResult;
}
export interface OnPiiPolicyStart {
  onPiiPolicyStart(event: PiiPolicyStartEvent): HookResult;
}
export interface OnPiiPolicyEnd {
  onPiiPolicyEnd(event: PiiPolicyEndEvent): HookResult;
}
export interface OnActionStart {
  onActionStart(event: ActionStartEvent): HookResult;
}
export interface OnActionEnd {
  onActionEnd(event: ActionEndEvent): HookResult;
}
export interface OnChannelStart {
  onChannelStart(event: ChannelStartEvent): HookResult;
}
export interface OnChannelEnd {
  onChannelEnd(event: ChannelEndEvent): HookResult;
}
export interface OnJudgeStart {
  onJudgeStart(event: JudgeStartEvent): HookResult;
}
export interface OnJudgeEnd {
  onJudgeEnd(event: JudgeEndEvent): HookResult;
}
/**
 * A write outdated values of the path scope (#271): once per cascade — the new value and every
 * value it made stale, with the reasons; never empty, never the DTO values.
 */
export interface OnValuesOutdated {
  onValuesOutdated(event: ValuesOutdatedEvent): HookResult;
}
/**
 * A per-item launch took the first `maxItems` items of a longer list (#273): once per such launch,
 * with how many items there were — truncation is never an error.
 */
export interface OnLaunchItemsTruncated {
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): HookResult;
}

/** Every hook, all optional: the type of an observer instance. */
export type WorkflowObserver = Partial<
  OnWorkflowStart &
    OnWorkflowPause &
    OnWorkflowResume &
    OnWorkflowEnd &
    OnRunRejected &
    OnAgentStart &
    OnAgentEnd &
    OnRouterStart &
    OnRouterEnd &
    OnToolStart &
    OnToolEnd &
    OnModelStart &
    OnModelEnd &
    OnRagStart &
    OnRagEnd &
    OnError &
    OnGuardrailStart &
    OnGuardrailEnd &
    OnPiiPolicyStart &
    OnPiiPolicyEnd &
    OnActionStart &
    OnActionEnd &
    OnChannelStart &
    OnChannelEnd &
    OnJudgeStart &
    OnJudgeEnd &
    OnValuesOutdated &
    OnLaunchItemsTruncated
>;

/** The name of a hook, e.g. `"onToolEnd"`. */
export type ObserverHook = keyof WorkflowObserver;

/** A class for `@Workflow({ observers })`: its instances implement some of the hooks. */
export type ObserverClass = Class<WorkflowObserver>;

/** Every hook name; a `Record` so a hook added to `WorkflowObserver` must be listed here. */
const HOOKS: Readonly<Record<ObserverHook, true>> = {
  onWorkflowStart: true,
  onWorkflowPause: true,
  onWorkflowResume: true,
  onWorkflowEnd: true,
  onRunRejected: true,
  onAgentStart: true,
  onAgentEnd: true,
  onRouterStart: true,
  onRouterEnd: true,
  onToolStart: true,
  onToolEnd: true,
  onModelStart: true,
  onModelEnd: true,
  onRagStart: true,
  onRagEnd: true,
  onError: true,
  onGuardrailStart: true,
  onGuardrailEnd: true,
  onPiiPolicyStart: true,
  onPiiPolicyEnd: true,
  onActionStart: true,
  onActionEnd: true,
  onChannelStart: true,
  onChannelEnd: true,
  onJudgeStart: true,
  onJudgeEnd: true,
  onValuesOutdated: true,
  onLaunchItemsTruncated: true,
};

export const OBSERVER_HOOKS: readonly ObserverHook[] = Object.keys(HOOKS).filter(
  (name): name is ObserverHook => name in HOOKS,
);
