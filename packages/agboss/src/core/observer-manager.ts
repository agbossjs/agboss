import { ObserverHookCalls } from "./observer-manager-calls.js";
import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
import type { CompactionEndEvent, CompactionStartEvent } from "../flow/observers/compaction.js";
import type { QuorumDecidedEvent } from "../flow/observers/quorum-decided.js";
import type { CircuitStateChangeEvent } from "../flow/observers/circuit-state.js";
import type {
  CompensationEndEvent,
  CompensationStartEvent,
} from "../flow/observers/compensation-events.js";
import type {} from "../flow/observers/audit-log.js";
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
  ExecutionCancelEvent,
  ExecutionErrorEvent,
  ExecutionStopEvent,
  ExecutionPauseEvent,
  ExecutionRejectedEvent,
  ExecutionResumeEvent,
  ExecutionStartEvent,
  ToolEndEvent,
  ToolStartEvent,
  AgentRetryEvent,
} from "./observability.js";
import { isWanted, type ObserverHook, type ExecutionObserver } from "./observer-hooks.js";
import { callAll, type ObserverFailure } from "./observer-call.js";

export { unmasked, type EventMask, type UnknownCostTally } from "./observer-mask.js";
import { unmasked, type EventMask, type UnknownCostTally } from "./observer-mask.js";

export type { ObserverFailure } from "./observer-call.js";

/** Without a listener a failing hook is only skipped (the application logs it, `observer.failed`). */
const ignore: ObserverFailure = () => undefined;

/**
 * Calls a hook on the application's observers (`@Application({ observers })`), in their order.
 * An observer that throws is reported to `onFailure` (the application's log: a warning) and
 * skipped: it never fails the execution.
 */
export class ExecutionObserverManager
  extends ObserverHookCalls
  implements Required<ExecutionObserver>
{
  /**
   * `builtIn`: the framework's own observers (#485: the instance's metrics) — called first, on the
   * event as it is: they read enums and names only, so no mask runs for them. `unknownCosts`: the
   * instance's tally of Unknown-cost entries (#875); absent = not counted.
   */
  constructor(
    private readonly observers: readonly ExecutionObserver[],
    private readonly onFailure: ObserverFailure = ignore,
    private readonly mask: EventMask = unmasked,
    private readonly builtIn: readonly ExecutionObserver[] = [],
    readonly unknownCosts?: UnknownCostTally,
  ) {
    super();
  }

  /** The same observers, every event masked first (a workflow's PII policies, #120 AC7). */
  masked(mask: EventMask): ExecutionObserverManager {
    const { observers, onFailure, builtIn, unknownCosts } = this;
    return new ExecutionObserverManager(observers, onFailure, mask, builtIn, unknownCosts);
  }

  protected async each<TEvent>(
    hook: ObserverHook,
    event: TEvent,
    call: (observer: ExecutionObserver, event: TEvent) => Promise<void> | void,
  ): Promise<void> {
    await callAll(this.builtIn, hook, event, call, this.onFailure);
    // an observer's `workflows` / `agents` read the event as it is, before the mask
    const wanting = this.observers.filter((observer) => isWanted(observer, event as object));
    if (wanting.length === 0) return;
    // the mask keeps an event's shape: every string masked, class instances (errors) as they are
    const shown = (await this.mask(event)) as TEvent;
    await callAll(wanting, hook, shown, call, this.onFailure);
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
  onExecutionStop(event: ExecutionStopEvent): Promise<void> {
    return this.each("onExecutionStop", event, (o, e) => o.onExecutionStop?.(e));
  }
  onExecutionCancel(event: ExecutionCancelEvent): Promise<void> {
    return this.each("onExecutionCancel", event, (o, e) => o.onExecutionCancel?.(e));
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
  onAgentRetry(event: AgentRetryEvent): Promise<void> {
    return this.each("onAgentRetry", event, (o, e) => o.onAgentRetry?.(e));
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
  onCircuitStateChange(event: CircuitStateChangeEvent): Promise<void> {
    return this.each("onCircuitStateChange", event, (o, e) => o.onCircuitStateChange?.(e));
  }
  onCompactionStart(event: CompactionStartEvent): Promise<void> {
    return this.each("onCompactionStart", event, (o, e) => o.onCompactionStart?.(e));
  }
  onCompactionEnd(event: CompactionEndEvent): Promise<void> {
    return this.each("onCompactionEnd", event, (o, e) => o.onCompactionEnd?.(e));
  }
  onCompensationStart(event: CompensationStartEvent): Promise<void> {
    return this.each("onCompensationStart", event, (o, e) => o.onCompensationStart?.(e));
  }
  onCompensationEnd(event: CompensationEndEvent): Promise<void> {
    return this.each("onCompensationEnd", event, (o, e) => o.onCompensationEnd?.(e));
  }
}
