import type { Class } from "../components/injection.js";
import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
import type { QuorumDecidedEvent } from "../flow/observers/quorum-decided.js";
import type {
  CompensationEndEvent,
  CompensationStartEvent,
} from "../flow/observers/compensation-events.js";
import type {
  OnExecutionLeaseTakeover,
  OnFencedEffect,
  OnStepHandedOver,
} from "../flow/observers/lease-events.js";
import type {
  ActionEndEvent,
  ActionStartEvent,
  AgentEndEvent,
  AgentStartEvent,
  ChannelEndEvent,
  ChannelStartEvent,
  GuardrailEndEvent,
  GuardrailStartEvent,
  JudgeEndEvent,
  JudgeStartEvent,
  ModelEndEvent,
  ModelStartEvent,
  RagEndEvent,
  RagStartEvent,
  RouterEndEvent,
  RouterStartEvent,
  ExecutionEndEvent,
  ExecutionErrorEvent,
  ExecutionPauseEvent,
  ExecutionRejectedEvent,
  ExecutionResumeEvent,
  ExecutionStartEvent,
  ToolEndEvent,
  ToolStartEvent,
} from "./observability.js";

/** What a hook may return: it is awaited, its value is ignored. */
type HookResult = Promise<void> | void;

/**
 * Observer hooks, one interface per hook (#261). An observer class implements any of them and is
 * listed in `@Application({ observers: [...] })`; only listed classes are called — for every
 * execution of the application, child executions included (filter by `event.workflow.name`).
 */
/** Once per execution, at `execute` (a resume does not start it again). */
export interface OnExecutionStart {
  onExecutionStart(event: ExecutionStartEvent): HookResult;
}
/** The execution paused (an approval, a channel); `onExecutionResume` follows when it continues. */
export interface OnExecutionPause {
  onExecutionPause(event: ExecutionPauseEvent): HookResult;
}
/** `app.resume` picked the paused execution up, or recovery continues an interrupted one. */
export interface OnExecutionResume {
  onExecutionResume(event: ExecutionResumeEvent): HookResult;
}
/**
 * A request was refused before an execution started or was located (`execute`, `resume` or
 * `cancel` of another owner's thread, a resume with nothing paused, an unknown thread, invalid
 * input, an exhausted budget, a stopping app).
 */
export interface OnExecutionRejected {
  onExecutionRejected(event: ExecutionRejectedEvent): HookResult;
}
/** The execution ended at a finish — at `execute`, or after a resume; once per execution. */
export interface OnExecutionEnd {
  onExecutionEnd(event: ExecutionEndEvent): HookResult;
}
/**
 * The execution failed (also after a resume, or cancelled while paused: `ExecutionCancelledError`),
 * or a resume of a paused one was refused as incompatible (`IncompatibleResumeError`; it stays
 * paused).
 */
export interface OnExecutionError {
  onExecutionError(event: ExecutionErrorEvent): HookResult;
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
export interface OnGuardrailStart {
  onGuardrailStart(event: GuardrailStartEvent): HookResult;
}
export interface OnGuardrailEnd {
  onGuardrailEnd(event: GuardrailEndEvent): HookResult;
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
  /** Called once per truncated launch, after the launching step. */
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): HookResult;
}
/**
 * A quorum join decided (#279): once per quorum, with each branch's verdict (counted, rejected and
 * by which arbiters, surplus, or none when cancelled) and the winning group.
 */
export interface OnQuorumDecided {
  /** Called once per quorum join, before the execution goes on (or into `.onJoinError`). */
  onQuorumDecided(event: QuorumDecidedEvent): HookResult;
}

/**
 * An automatic undo action starts (#340): a failed join undoing its finished branches — once per
 * undo action, newest first, before `.onJoinError`.
 */
export interface OnCompensationStart {
  /** Called before each automatic undo action runs, in its frame. */
  onCompensationStart(event: CompensationStartEvent): HookResult;
}
/** An automatic undo action ended: `status` `Compensated` or `Failed` (with its `error`). */
export interface OnCompensationEnd {
  /** Called after each automatic undo action, whether it returned or threw. */
  onCompensationEnd(event: CompensationEndEvent): HookResult;
}

/** Every hook, all optional: the type of an observer instance. */
export type ExecutionObserver = Partial<
  OnExecutionStart &
    OnExecutionPause &
    OnExecutionResume &
    OnExecutionEnd &
    OnExecutionError &
    OnExecutionRejected &
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
    OnGuardrailStart &
    OnGuardrailEnd &
    OnActionStart &
    OnActionEnd &
    OnChannelStart &
    OnChannelEnd &
    OnJudgeStart &
    OnJudgeEnd &
    OnValuesOutdated &
    OnLaunchItemsTruncated &
    OnQuorumDecided &
    OnCompensationStart &
    OnCompensationEnd &
    OnExecutionLeaseTakeover &
    OnStepHandedOver &
    OnFencedEffect
>;

/** The name of a hook, e.g. `"onToolEnd"`. */
export type ObserverHook = keyof ExecutionObserver;

/** A class for `@Application({ observers })`: its instances implement some of the hooks. */
export type ObserverClass = Class<ExecutionObserver>;

/** Every hook name; a `Record` so a hook added to `ExecutionObserver` must be listed here. */
const HOOKS: Readonly<Record<ObserverHook, true>> = {
  onExecutionStart: true,
  onExecutionPause: true,
  onExecutionResume: true,
  onExecutionEnd: true,
  onExecutionError: true,
  onExecutionRejected: true,
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
  onGuardrailStart: true,
  onGuardrailEnd: true,
  onActionStart: true,
  onActionEnd: true,
  onChannelStart: true,
  onChannelEnd: true,
  onJudgeStart: true,
  onJudgeEnd: true,
  onValuesOutdated: true,
  onLaunchItemsTruncated: true,
  onQuorumDecided: true,
  onCompensationStart: true,
  onCompensationEnd: true,
  onExecutionLeaseTakeover: true,
  onStepHandedOver: true,
  onFencedEffect: true,
};

export const OBSERVER_HOOKS: readonly ObserverHook[] = Object.keys(HOOKS).filter(
  (name): name is ObserverHook => name in HOOKS,
);
