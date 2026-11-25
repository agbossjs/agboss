import {
  Observer,
  type CompensationEndEvent,
  type ExecutionCancelEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLeaseTakeoverEvent,
  type StepHandedOverEvent,
} from "../../../index.js";
import { FaultPodLink } from "./pod-link.js";

/**
 * Tells the test what the fixture application's instance heard (#484): every execution's end or
 * failure, every takeover of a lease, every step handed over and every undo that ran — the
 * moments a scenario waits for. The invariants themselves are read from the stores afterwards.
 */
@Observer({ deps: [FaultPodLink] })
export class FaultObserver {
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

  /**
   * A cancelled execution (#1341) ends as a failure did: the scenarios wait for its end and count
   * what it undid — its error is the cancel's class name.
   */
  onExecutionCancel(event: ExecutionCancelEvent): void {
    const { executionId, rootExecutionId, tenantId, compensations } = event;
    this.faultPodLink.emit("failed", {
      executionId,
      rootExecutionId,
      tenantId,
      error: "ExecutionCancelledError",
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
