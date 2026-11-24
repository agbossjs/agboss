import {
  Injectable,
  type CompensationEndEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLeaseTakeoverEvent,
  type OnCompensationEnd,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionLeaseTakeover,
  type OnStepHandedOver,
  type StepHandedOverEvent,
} from "../../../index.js";
import { FaultPodLink } from "./pod-link.js";

/**
 * Tells the test what the fixture application's instance heard (#484): every execution's end or
 * failure, every takeover of a lease, every step handed over and every undo that ran — the
 * moments a scenario waits for. The invariants themselves are read from the stores afterwards.
 */
@Injectable({ deps: [FaultPodLink] })
export class FaultObserver
  implements
    OnExecutionEnd,
    OnExecutionError,
    OnExecutionLeaseTakeover,
    OnStepHandedOver,
    OnCompensationEnd
{
  constructor(private readonly faultPodLink: FaultPodLink) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    const { executionId, rootExecutionId, parentExecutionId, tenantId, finish } = event;
    const parent = parentExecutionId === undefined ? {} : { parentExecutionId };
    this.faultPodLink.emit("end", {
      executionId,
      rootExecutionId,
      tenantId,
      finish: finish.name,
      ...parent,
    });
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    const { executionId, rootExecutionId, tenantId, error, compensations } = event;
    this.faultPodLink.emit("failed", {
      executionId,
      rootExecutionId,
      tenantId,
      error: error.name,
      compensations: compensations.length,
    });
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    this.faultPodLink.emit("takeover", { ...event });
  }

  onStepHandedOver(event: StepHandedOverEvent): void {
    const { executionId, rootExecutionId, reason, site, token } = event;
    this.faultPodLink.emit("handed-over", { executionId, rootExecutionId, reason, site, token });
  }

  onCompensationEnd(event: CompensationEndEvent): void {
    const { executionId, rootExecutionId, status } = event;
    this.faultPodLink.emit("compensated", { executionId, rootExecutionId, status });
  }
}
