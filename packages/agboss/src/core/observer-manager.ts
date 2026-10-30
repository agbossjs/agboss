import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
import type { QuorumDecidedEvent } from "../flow/observers/quorum-decided.js";
import type {
  CompensationEndEvent,
  CompensationStartEvent,
} from "../flow/observers/compensation-events.js";
import type {
  ExecutionLeaseTakeoverEvent,
  FencedEffectEvent,
  OutboundCallEvent,
  StepHandedOverEvent,
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
import type { ObserverHook, ExecutionObserver } from "./observer-hooks.js";

/** What an event goes through before any observer sees it (the PII observability mask, #120). */
export type EventMask = (event: unknown) => Promise<unknown>;

const unmasked: EventMask = (event) => Promise.resolve(event);

/** Told when an observer's hook throws; the execution goes on. */
export type ObserverFailure = (observer: string, hook: ObserverHook, error: unknown) => void;

/** Without a listener a failing hook is only skipped (the application logs it, `observer.failed`). */
const ignore: ObserverFailure = () => undefined;

/**
 * Calls a hook on the application's observers (`@Application({ observers })`), in their order.
 * An observer that throws is reported to `onFailure` (the application's log: a warning) and
 * skipped: it never fails the execution.
 */
export class ExecutionObserverManager implements Required<ExecutionObserver> {
  constructor(
    private readonly observers: readonly ExecutionObserver[],
    private readonly onFailure: ObserverFailure = ignore,
    private readonly mask: EventMask = unmasked,
  ) {}

  /** The same observers, every event masked first (a workflow's PII policies, #120 AC7). */
  masked(mask: EventMask): ExecutionObserverManager {
    return new ExecutionObserverManager(this.observers, this.onFailure, mask);
  }

  private async each<TEvent>(
    hook: ObserverHook,
    event: TEvent,
    call: (observer: ExecutionObserver, event: TEvent) => Promise<void> | void,
  ): Promise<void> {
    if (this.observers.length === 0) return;
    // the mask keeps an event's shape: every string masked, class instances (errors) as they are
    const shown = (await this.mask(event)) as TEvent;
    for (const observer of this.observers) {
      try {
        await call(observer, shown);
      } catch (error) {
        this.onFailure(observer.constructor.name, hook, error);
      }
    }
  }

  onExecutionStart(event: ExecutionStartEvent): Promise<void> {
    return this.each("onExecutionStart", event, (o, e) => o.onExecutionStart?.(e));
  }
  onExecutionPause(event: ExecutionPauseEvent): Promise<void> {
    return this.each("onExecutionPause", event, (o, e) => o.onExecutionPause?.(e));
  }
  onExecutionResume(event: ExecutionResumeEvent): Promise<void> {
    return this.each("onExecutionResume", event, (o, e) => o.onExecutionResume?.(e));
  }
  onExecutionEnd(event: ExecutionEndEvent): Promise<void> {
    return this.each("onExecutionEnd", event, (o, e) => o.onExecutionEnd?.(e));
  }
  onExecutionError(event: ExecutionErrorEvent): Promise<void> {
    return this.each("onExecutionError", event, (o, e) => o.onExecutionError?.(e));
  }
  onExecutionRejected(event: ExecutionRejectedEvent): Promise<void> {
    return this.each("onExecutionRejected", event, (o, e) => o.onExecutionRejected?.(e));
  }
  onAgentStart(event: AgentStartEvent): Promise<void> {
    return this.each("onAgentStart", event, (o, e) => o.onAgentStart?.(e));
  }
  onAgentEnd(event: AgentEndEvent): Promise<void> {
    return this.each("onAgentEnd", event, (o, e) => o.onAgentEnd?.(e));
  }
  onRouterStart(event: RouterStartEvent): Promise<void> {
    return this.each("onRouterStart", event, (o, e) => o.onRouterStart?.(e));
  }
  onRouterEnd(event: RouterEndEvent): Promise<void> {
    return this.each("onRouterEnd", event, (o, e) => o.onRouterEnd?.(e));
  }
  onToolStart(event: ToolStartEvent): Promise<void> {
    return this.each("onToolStart", event, (o, e) => o.onToolStart?.(e));
  }
  onToolEnd(event: ToolEndEvent): Promise<void> {
    return this.each("onToolEnd", event, (o, e) => o.onToolEnd?.(e));
  }
  onModelStart(event: ModelStartEvent): Promise<void> {
    return this.each("onModelStart", event, (o, e) => o.onModelStart?.(e));
  }
  onModelEnd(event: ModelEndEvent): Promise<void> {
    return this.each("onModelEnd", event, (o, e) => o.onModelEnd?.(e));
  }
  onRagStart(event: RagStartEvent): Promise<void> {
    return this.each("onRagStart", event, (o, e) => o.onRagStart?.(e));
  }
  onRagEnd(event: RagEndEvent): Promise<void> {
    return this.each("onRagEnd", event, (o, e) => o.onRagEnd?.(e));
  }
  onGuardrailStart(event: GuardrailStartEvent): Promise<void> {
    return this.each("onGuardrailStart", event, (o, e) => o.onGuardrailStart?.(e));
  }
  onGuardrailEnd(event: GuardrailEndEvent): Promise<void> {
    return this.each("onGuardrailEnd", event, (o, e) => o.onGuardrailEnd?.(e));
  }
  onActionStart(event: ActionStartEvent): Promise<void> {
    return this.each("onActionStart", event, (o, e) => o.onActionStart?.(e));
  }
  onActionEnd(event: ActionEndEvent): Promise<void> {
    return this.each("onActionEnd", event, (o, e) => o.onActionEnd?.(e));
  }
  onChannelStart(event: ChannelStartEvent): Promise<void> {
    return this.each("onChannelStart", event, (o, e) => o.onChannelStart?.(e));
  }
  onChannelEnd(event: ChannelEndEvent): Promise<void> {
    return this.each("onChannelEnd", event, (o, e) => o.onChannelEnd?.(e));
  }
  onJudgeStart(event: JudgeStartEvent): Promise<void> {
    return this.each("onJudgeStart", event, (o, e) => o.onJudgeStart?.(e));
  }
  onJudgeEnd(event: JudgeEndEvent): Promise<void> {
    return this.each("onJudgeEnd", event, (o, e) => o.onJudgeEnd?.(e));
  }
  onValuesOutdated(event: ValuesOutdatedEvent): Promise<void> {
    return this.each("onValuesOutdated", event, (o, e) => o.onValuesOutdated?.(e));
  }
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent): Promise<void> {
    return this.each("onLaunchItemsTruncated", event, (o, e) => o.onLaunchItemsTruncated?.(e));
  }
  onQuorumDecided(event: QuorumDecidedEvent): Promise<void> {
    return this.each("onQuorumDecided", event, (o, e) => o.onQuorumDecided?.(e));
  }
  onCompensationStart(event: CompensationStartEvent): Promise<void> {
    return this.each("onCompensationStart", event, (o, e) => o.onCompensationStart?.(e));
  }
  onCompensationEnd(event: CompensationEndEvent): Promise<void> {
    return this.each("onCompensationEnd", event, (o, e) => o.onCompensationEnd?.(e));
  }
  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): Promise<void> {
    return this.each("onExecutionLeaseTakeover", event, (o, e) => o.onExecutionLeaseTakeover?.(e));
  }
  onStepHandedOver(event: StepHandedOverEvent): Promise<void> {
    return this.each("onStepHandedOver", event, (o, e) => o.onStepHandedOver?.(e));
  }
  onFencedEffect(event: FencedEffectEvent): Promise<void> {
    return this.each("onFencedEffect", event, (o, e) => o.onFencedEffect?.(e));
  }
  onOutboundCall(event: OutboundCallEvent): Promise<void> {
    return this.each("onOutboundCall", event, (o, e) => o.onOutboundCall?.(e));
  }
}
