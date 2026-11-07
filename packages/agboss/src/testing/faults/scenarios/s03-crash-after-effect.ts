import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import type { FaultPod } from "../pod.js";
import type { FaultCluster } from "../cluster.js";
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
  cluster: FaultCluster,
  orderId: string,
  point: FaultStepPoint,
  type: string,
): Promise<{ readonly reader: FaultPod; readonly outcomes: string[] }> {
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  await holdStep(a, point, orderId);
  const order = await startOrder(cluster, a, orderId);
  await heldStep(cluster, a, point, orderId);
  await a.kill();
  await takenOverBy(cluster, b, order.rootExecutionId);
  await endedOn(cluster, order.rootExecutionId, b);
  return {
    reader: b,
    outcomes: eventsOf(cluster, type).map((event) => `${event.pod}:${String(event.status)}`),
  };
}

export const s03FencedEffect: RunnableFaultScenario = {
  id: "s03-crash-after-charge",
  title:
    "3: a pod dies after its charge committed, before its checkpoint — the retry carries the same key and is replayed: one business row",
  run: async (cluster) => {
    const { reader, outcomes } = await crashAfter(
      cluster,
      "o-3",
      FaultStepPoint.ChargeAfter,
      "charged",
    );
    expectThat(
      cluster,
      outcomes.join() === "a:ran,b:replayed",
      `the charge's outcomes: ${outcomes.join(", ")}`,
    );
    return reader;
  },
};

export const s03Payment: RunnableFaultScenario = {
  id: "s03b-crash-after-payment",
  title:
    "3b: a pod dies after the gateway answered its payment, before its checkpoint — the retry is replayed, the gateway saw one request",
  run: async (cluster) => {
    const { reader, outcomes } = await crashAfter(cluster, "o-3b", FaultStepPoint.PayAfter, "paid");
    expectThat(
      cluster,
      outcomes.join() === "a:sent,b:replayed",
      `the payment's outcomes: ${outcomes.join(", ")}`,
    );
    const requests = cluster.gateway.requests.length;
    expectThat(cluster, requests === 1, `the gateway saw ${String(requests)} requests`);
    return reader;
  },
};
