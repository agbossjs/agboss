import { A2AExpose } from "../../../a2a/a2a-expose.decorator.js";
import { A2ACallerResolution, type A2ACallerResolver } from "../../../a2a/a2a-caller.js";
import { Injectable } from "../../../components/decorators.js";
import type { Class } from "../../../components/injection.js";
import { A2ATaskRepository } from "../../../infrastructure/a2a-task.repository.js";
import { FaultApprovalWorkflowStart } from "./approval.workflow.js";
import { FaultOrderWorkflowStart } from "./order.workflow.js";

/**
 * The fault fixture served over A2A (#811 AC4): only on a store set that lists an
 * `A2ATaskRepository` (found by inheritance, as the application finds it) — the order and the
 * approved order exported, every caller the one owner `fault-caller`. A set without one serves no
 * A2A: its A2A scenarios are skipped with the reason, never run on tasks no instance shares.
 */

/** The one owner every A2A caller of the fixture is. */
export const FAULT_A2A_OWNER = "fault-caller";

@A2AExpose({
  name: "fault-a2a-expose",
  version: "1.0.0",
  description: "Takes the fault fixture's orders over A2A",
  exports: [FaultOrderWorkflowStart, FaultApprovalWorkflowStart],
})
export class FaultA2AExpose {}

/** Every caller is the fixture's owner, in the default tenant. */
@Injectable()
export class FaultCallerResolver implements A2ACallerResolver<Class> {
  resolveCaller(): A2ACallerResolution<Class> {
    return A2ACallerResolution.resolved<Class>({ ownerId: FAULT_A2A_OWNER });
  }
}

/** Whether a store set's providers keep A2A tasks: one of them extends `A2ATaskRepository`. */
export const keepsA2ATasks = (providers: readonly Class[]): boolean =>
  providers.some((provider) =>
    Object.prototype.isPrototypeOf.call(A2ATaskRepository.prototype, provider.prototype),
  );
