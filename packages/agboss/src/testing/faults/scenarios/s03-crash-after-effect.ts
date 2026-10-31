import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultScenario } from "../scenario.js";
import type { FaultPod } from "../pod.js";
import type { FaultWorld } from "../world.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 3 (#484, #472, #500, #505): a pod dies after an external side effect, before its
 * checkpoint. The step runs again on the pod that takes the tree over, with the same idempotency
 * key, and the effect happens once: the fenced charge's business row was committed — the retry is
 * `Replayed` (3); the payment was answered and stored — the retry replays it, the gateway saw one
 * request (3b).
 */

/** Pod a killed while held after `point`; b finishes the tree. The statuses `type` events had, by pod. */
async function crashAfter(
  world: FaultWorld,
  orderId: string,
  point: FaultStepPoint,
  type: string,
): Promise<{ readonly reader: FaultPod; readonly outcomes: string[] }> {
  const a = await world.pod("a");
  const b = await world.pod("b");
  await holdStep(a, point, orderId);
  const order = await startOrder(world, a, orderId);
  await heldStep(world, a, point, orderId);
  await a.kill();
  await takenOverBy(world, b, order.rootExecutionId);
  await endedOn(world, order.rootExecutionId, b);
  return {
    reader: b,
    outcomes: eventsOf(world, type).map((event) => `${event.pod}:${String(event.status)}`),
  };
}

export const s03FencedEffect: FaultScenario = {
  id: "s03-crash-after-charge",
  title:
    "3: a pod dies after its charge committed, before its checkpoint — the retry carries the same key and is replayed: one business row",
  run: async (world) => {
    const { reader, outcomes } = await crashAfter(
      world,
      "o-3",
      FaultStepPoint.ChargeAfter,
      "charged",
    );
    expectThat(
      world,
      outcomes.join() === "a:ran,b:replayed",
      `the charge's outcomes: ${outcomes.join(", ")}`,
    );
    return reader;
  },
};

export const s03Payment: FaultScenario = {
  id: "s03b-crash-after-payment",
  title:
    "3b: a pod dies after the gateway answered its payment, before its checkpoint — the retry is replayed, the gateway saw one request",
  run: async (world) => {
    const { reader, outcomes } = await crashAfter(world, "o-3b", FaultStepPoint.PayAfter, "paid");
    expectThat(
      world,
      outcomes.join() === "a:sent,b:replayed",
      `the payment's outcomes: ${outcomes.join(", ")}`,
    );
    const requests = world.gateway.requests.length;
    expectThat(world, requests === 1, `the gateway saw ${String(requests)} requests`);
    return reader;
  },
};
