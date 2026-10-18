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
import type { ObserverHook, WorkflowObserver } from "./observer-hooks.js";

/** Told when an observer's hook throws; the run goes on. */
export type ObserverFailure = (observer: string, hook: ObserverHook, error: unknown) => void;

const warn: ObserverFailure = (observer, hook, error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`${observer}.${hook} threw: ${message}`, { code: "observer.failed" });
};

/**
 * Calls a hook on the workflow's observers (`@Workflow({ observers })`), in their order. An
 * observer that throws is reported to `onFailure` and skipped: it never fails the run.
 */
export class ObserverManager implements Required<WorkflowObserver> {
  constructor(
    private readonly observers: readonly WorkflowObserver[],
    private readonly onFailure: ObserverFailure = warn,
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

  onWorkflowStart(state: AppState): Promise<void> {
    return this.each("onWorkflowStart", (o) => o.onWorkflowStart?.(state));
  }
  onWorkflowPause(event: WorkflowPauseEvent): Promise<void> {
    return this.each("onWorkflowPause", (o) => o.onWorkflowPause?.(event));
  }
  onWorkflowResume(event: WorkflowResumeEvent): Promise<void> {
    return this.each("onWorkflowResume", (o) => o.onWorkflowResume?.(event));
  }
  onWorkflowEnd(result: ExecutionOutput, state: AppState): Promise<void> {
    return this.each("onWorkflowEnd", (o) => o.onWorkflowEnd?.(result, state));
  }
  onRunRejected(event: RunRejectedEvent): Promise<void> {
    return this.each("onRunRejected", (o) => o.onRunRejected?.(event));
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
  onError(error: Error, state: AppState): Promise<void> {
    return this.each("onError", (o) => o.onError?.(error, state));
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
