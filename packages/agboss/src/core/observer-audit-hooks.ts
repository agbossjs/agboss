import type {
  ExecutionLeaseTakeoverEvent,
  IdempotencyRunEvent,
  OutboundCallEvent,
  StepHandedOverEvent,
} from "../flow/observers/audit-log.js";
import type { InterruptCleanupErrorEvent } from "./observability.js";
import type { ExecutionObserver, ObserverHook } from "./observer-hooks.js";

/**
 * The hooks of the lease, the hand-over, the idempotent effects, the calls that leave the system and
 * the interrupted step's cleanups (#501, #505, #1341b): the manager's `each` runs each one, so the
 * manager's own file stays below the size bound.
 */
export abstract class AuditObserverHooks {
  protected abstract each<TEvent>(
    hook: ObserverHook,
    event: TEvent,
    call: (observer: ExecutionObserver, event: TEvent) => Promise<void> | void,
  ): Promise<void>;

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): Promise<void> {
    return this.each("onExecutionLeaseTakeover", event, (o, e) => o.onExecutionLeaseTakeover?.(e));
  }
  onInterruptCleanupError(event: InterruptCleanupErrorEvent): Promise<void> {
    return this.each("onInterruptCleanupError", event, (o, e) => o.onInterruptCleanupError?.(e));
  }
  onStepHandedOver(event: StepHandedOverEvent): Promise<void> {
    return this.each("onStepHandedOver", event, (o, e) => o.onStepHandedOver?.(e));
  }
  onIdempotencyRun(event: IdempotencyRunEvent): Promise<void> {
    return this.each("onIdempotencyRun", event, (o, e) => o.onIdempotencyRun?.(e));
  }
  onOutboundCall(event: OutboundCallEvent): Promise<void> {
    return this.each("onOutboundCall", event, (o, e) => o.onOutboundCall?.(e));
  }
}
