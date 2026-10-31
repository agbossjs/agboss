import type { PodEventFact } from "../facts.js";
import { FaultStepPoint, stepPointOf } from "../fixture/pod-link.js";
import type { FaultPod } from "../pod.js";
import { FaultWorkflow } from "../pod-protocol.js";
import type { FaultWorld } from "../world.js";
import { heldAt } from "./kit.js";

/**
 * The batch scenarios' helpers (#484): start a batch of orders, each a child on any instance, and
 * learn which child each pod holds.
 */

/** A batch the scenario started: its root and its orders. */
export interface StartedBatch {
  readonly rootExecutionId: string;
  readonly orderIds: readonly string[];
}

/** Starts a batch of `orderIds` on `pod`; resolves once a first child ran a step. */
export async function startBatch(
  world: FaultWorld,
  pod: FaultPod,
  orderIds: readonly string[],
): Promise<StartedBatch> {
  await world.start(
    pod,
    FaultWorkflow.Batch,
    orderIds.map((orderId) => ({ orderId })),
  );
  const first = await world.next(
    "a first child's step",
    (event) => event.type === "step" && orderIds.includes(String(event.orderId)),
  );
  return { rootExecutionId: String(first.rootExecutionId), orderIds };
}

/** The child `pod` holds at its charge: its held operation, its order and its execution. */
export interface HeldChild {
  readonly held: PodEventFact;
  readonly orderId: string;
  readonly executionId: string;
}

/** The first child held at its charge on `pod`. */
export async function heldChildOn(world: FaultWorld, pod: FaultPod): Promise<HeldChild> {
  const held = await heldAt(world, pod, stepPointOf(FaultStepPoint.ChargeBefore));
  const orderId = String(held.key);
  const step = await world.next(
    `the charge step of ${orderId} on ${pod.name}`,
    (event) =>
      event.type === "step" &&
      event.pod === pod.name &&
      event.orderId === orderId &&
      event.point === FaultStepPoint.ChargeBefore,
  );
  return { held, orderId, executionId: String(step.executionId) };
}

/** The pods each order's charge step ran on, in order. */
export const chargePodsOf = (world: FaultWorld, orderId: string): readonly string[] =>
  world.events
    .filter(
      (event) =>
        event.type === "step" &&
        event.orderId === orderId &&
        event.point === FaultStepPoint.ChargeBefore,
    )
    .map((event) => event.pod);
