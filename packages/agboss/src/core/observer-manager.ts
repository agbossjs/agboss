import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
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
  PiiPolicyEndEvent,
  PiiPolicyStartEvent,
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
import type { ObserverHook, WorkflowObserver } from "./observer-hooks.js";

/** Told when an observer's hook throws; the execution goes on. */
export type ObserverFailure = (observer: string, hook: ObserverHook, error: unknown) => void;

/** Without a listener a failing hook is only skipped (the application logs it, `observer.failed`). */
const ignore: ObserverFailure = () => undefined;

/**
 * Calls a hook on the application's observers (`@Application({ observers })`), in their order.
 * An observer that throws is reported to `onFailure` (the application's log: a warning) and
 * skipped: it never fails the execution.
 */
export class ObserverManager implements Required<WorkflowObserver> {
  constructor(
    private readonly observers: readonly WorkflowObserver[],
    private readonly onFailure: ObserverFailure = ignore,
  ) {}

  private async each(
    hook: ObserverHook,
    call: (observer: WorkflowObserver) => Promise<void> | void,
  ): Promise<void> {
    for (const observer of this.observers) {
      try {
        await call(observer);
      } catch (error) {
        this.onFailure(observer.constructor.name, hook, error);
      }
    }
  }

  onExecutionStart(event: ExecutionStartEvent): Promise<void> {
    return this.each("onExecutionStart", (o) => o.onExecutionStart?.(event));
  }
  onExecutionPause(event: ExecutionPauseEvent): Promise<void> {
    return this.each("onExecutionPause", (o) => o.onExecutionPause?.(event));
  }
  onExecutionResume(event: ExecutionResumeEvent): Promise<void> {
    return this.each("onExecutionResume", (o) => o.onExecutionResume?.(event));
  }
  onExecutionEnd(event: ExecutionEndEvent): Promise<void> {
    return this.each("onExecutionEnd", (o) => o.onExecutionEnd?.(event));
  }
  onExecutionError(event: ExecutionErrorEvent): Promise<void> {
    return this.each("onExecutionError", (o) => o.onExecutionError?.(event));
  }
  onExecutionRejected(event: ExecutionRejectedEvent): Promise<void> {
    return this.each("onExecutionRejected", (o) => o.onExecutionRejected?.(event));
  }
  onAgentStart(event: AgentStartEvent): Promise<void> {
    return this.each("onAgentStart", (o) => o.onAgentStart?.(event));
  }
  onAgentEnd(event: AgentEndEvent): Promise<void> {
    return this.each("onAgentEnd", (o) => o.onAgentEnd?.(event));
  }
  onRouterStart(event: RouterStartEvent): Promise<void> {
    return this.each("onRouterStart", (o) => o.onRouterStart?.(event));
  }
  onRouterEnd(event: RouterEndEvent): Promise<void> {
    return this.each("onRouterEnd", (o) => o.onRouterEnd?.(event));
  }
  onToolStart(event: ToolStartEvent): Promise<void> {
    return this.each("onToolStart", (o) => o.onToolStart?.(event));
  }
  onToolEnd(event: ToolEndEvent): Promise<void> {
    return this.each("onToolEnd", (o) => o.onToolEnd?.(event));
  }
  onModelStart(event: ModelStartEvent): Promise<void> {
    return this.each("onModelStart", (o) => o.onModelStart?.(event));
  }
  onModelEnd(event: ModelEndEvent): Promise<void> {
    return this.each("onModelEnd", (o) => o.onModelEnd?.(event));
  }
  onRagStart(event: RagStartEvent): Promise<void> {
    return this.each("onRagStart", (o) => o.onRagStart?.(event));
  }
  onRagEnd(event: RagEndEvent): Promise<void> {
    return this.each("onRagEnd", (o) => o.onRagEnd?.(event));
  }
  onGuardrailStart(event: GuardrailStartEvent): Promise<void> {
    return this.each("onGuardrailStart", (o) => o.onGuardrailStart?.(event));
  }
  onGuardrailEnd(event: GuardrailEndEvent): Promise<void> {
    return this.each("onGuardrailEnd", (o) => o.onGuardrailEnd?.(event));
  }
  onPiiPolicyStart(event: PiiPolicyStartEvent): Promise<void> {
    return this.each("onPiiPolicyStart", (o) => o.onPiiPolicyStart?.(event));
  }
  onPiiPolicyEnd(event: PiiPolicyEndEvent): Promise<void> {
    return this.each("onPiiPolicyEnd", (o) => o.onPiiPolicyEnd?.(event));
  }
  onActionStart(event: ActionStartEvent): Promise<void> {
    return this.each("onActionStart", (o) => o.onActionStart?.(event));
  }
  onActionEnd(event: ActionEndEvent): Promise<void> {
    return this.each("onActionEnd", (o) => o.onActionEnd?.(event));
  }
  onChannelStart(event: ChannelStartEvent): Promise<void> {
    return this.each("onChannelStart", (o) => o.onChannelStart?.(event));
  }
  onChannelEnd(event: ChannelEndEvent): Promise<void> {
    return this.each("onChannelEnd", (o) => o.onChannelEnd?.(event));
  }
  onJudgeStart(event: JudgeStartEvent): Promise<void> {
    return this.each("onJudgeStart", (o) => o.onJudgeStart?.(event));
  }
  onJudgeEnd(event: JudgeEndEvent): Promise<void> {
    return this.each("onJudgeEnd", (o) => o.onJudgeEnd?.(event));
  }
  onValuesOutdated(event: ValuesOutdatedEvent): Promise<void> {
    return this.each("onValuesOutdated", (o) => o.onValuesOutdated?.(event));
  }
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): Promise<void> {
    return this.each("onLaunchItemsTruncated", (o) => o.onLaunchItemsTruncated?.(event));
  }
}
