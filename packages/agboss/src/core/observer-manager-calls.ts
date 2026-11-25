import type { ArbiterEndEvent, ArbiterStartEvent } from "../flow/observers/arbiter.js";
import type { RerankEndEvent, RerankStartEvent } from "../flow/observers/rerank.js";
import type { ModelFallbackEvent } from "../flow/observers/model-fallback.js";
import type {
  ChannelInterpreterEndEvent,
  ChannelInterpreterStartEvent,
} from "../flow/observers/channel-interpreter.js";
import type { TtlSweepEvent } from "../flow/observers/ttl-sweep.js";
import type {
  PauseReassignedEvent,
  PauseTimeoutChangedEvent,
} from "../flow/observers/pause-changes.js";
import { AuditObserverHooks } from "./observer-audit-hooks.js";

/**
 * The hooks of an arbiter's judging, a reranking, a model's fallback, an interpreter's reading, the
 * retention sweep and an operator's change of a pause (#1343): the manager's `each` runs each one.
 */
export abstract class ObserverHookCalls extends AuditObserverHooks {
  onArbiterStart(event: ArbiterStartEvent): Promise<void> {
    return this.each("onArbiterStart", event, (o, e) => o.onArbiterStart?.(e));
  }
  onArbiterEnd(event: ArbiterEndEvent): Promise<void> {
    return this.each("onArbiterEnd", event, (o, e) => o.onArbiterEnd?.(e));
  }
  onRerankStart(event: RerankStartEvent): Promise<void> {
    return this.each("onRerankStart", event, (o, e) => o.onRerankStart?.(e));
  }
  onRerankEnd(event: RerankEndEvent): Promise<void> {
    return this.each("onRerankEnd", event, (o, e) => o.onRerankEnd?.(e));
  }
  onModelFallback(event: ModelFallbackEvent): Promise<void> {
    return this.each("onModelFallback", event, (o, e) => o.onModelFallback?.(e));
  }
  onChannelInterpreterStart(event: ChannelInterpreterStartEvent): Promise<void> {
    return this.each("onChannelInterpreterStart", event, (o, e) =>
      o.onChannelInterpreterStart?.(e),
    );
  }
  onChannelInterpreterEnd(event: ChannelInterpreterEndEvent): Promise<void> {
    return this.each("onChannelInterpreterEnd", event, (o, e) => o.onChannelInterpreterEnd?.(e));
  }
  onTtlSweep(event: TtlSweepEvent): Promise<void> {
    return this.each("onTtlSweep", event, (o, e) => o.onTtlSweep?.(e));
  }
  onPauseTimeoutChanged(event: PauseTimeoutChangedEvent): Promise<void> {
    return this.each("onPauseTimeoutChanged", event, (o, e) => o.onPauseTimeoutChanged?.(e));
  }
  onPauseReassigned(event: PauseReassignedEvent): Promise<void> {
    return this.each("onPauseReassigned", event, (o, e) => o.onPauseReassigned?.(e));
  }
}
