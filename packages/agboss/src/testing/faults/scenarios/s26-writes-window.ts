import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldAt,
  heldStep,
  holdStep,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";
import { chargesOf, statusesOf } from "./s22-kit.js";

/**
 * Scenarios 26a and 26b (#1090): a holder loses its tree after a task's writes were saved and
 * before the next checkpoint — its checkpoint write never answers (held for ever), it hands over at
 * the end of its trust and is killed. LangGraph leaves a task with saved writes out of `next`, so
 * recovery must not read the tree as finished: the next holder applies the saved writes and runs
 * what is left, once —
 * - 26a, after the reserve step's writes: the charge and the payment run on b, once each;
 * - 26b, after the charge's writes (the charge committed on a): b does not charge again, it pays,
 *   once, and the tree ends at its finish.
 */
async function writesSavedPutHeld(
  cluster: Parameters<RunnableFaultScenario["run"]>[0],
  orderId: string,
  point: FaultStepPoint,
) {
  const a = await cluster.pod("a", { isBounded: true });
  const b = await cluster.pod("b", { isBounded: true });
  await holdStep(a, point, orderId);
  const order = await startOrder(cluster, a, orderId);
  const stepHeld = await heldStep(cluster, a, point, orderId);
  const key = order.rootExecutionId;
  // the step goes on once its checkpoint write is armed: its writes are saved, the checkpoint never is
  await holdStore(a, StoreHoldPoint.CheckpointPut, key);
  await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
  await release(a, stepHeld);
  await heldAt(cluster, a, StoreHoldPoint.CheckpointPut, key);
  await cluster.next(
    `a's call ending with the hand-over of ${key}`,
    (event) => event.type === "execute-failed" && event.pod === a.name,
  );
  await a.kill();
  await takenOverBy(cluster, b, key);
  await endedOn(cluster, key, b);
  return { a, b, orderId };
}

export const s26aWritesSavedBeforeCharge: RunnableFaultScenario = {
  id: "s26a-writes-saved-before-charge",
  title:
    "26a: the checkpoint after the reserve step's writes never answers — the next holder applies the writes, charges and pays once, the tree finishes",
  run: async (cluster) => {
    const { a, b, orderId } = await writesSavedPutHeld(cluster, "o-26a", FaultStepPoint.Reserve);
    expectThat(
      cluster,
      statusesOf(cluster, "charged", b) === "ran",
      `b's charge was to run once; it was ${statusesOf(cluster, "charged", b)}`,
    );
    expectThat(cluster, eventsOf(cluster, "charged", a).length === 0, "a charged");
    expectThat(
      cluster,
      chargesOf(cluster, orderId) === "b",
      `the gateway's payments came from ${chargesOf(cluster, orderId)}, not b only`,
    );
    return b;
  },
};

export const s26bWritesSavedAfterCharge: RunnableFaultScenario = {
  id: "s26b-writes-saved-after-charge",
  title:
    "26b: the checkpoint after the charge's writes never answers — the next holder does not charge again, pays once, the tree finishes",
  run: async (cluster) => {
    const { a, b, orderId } = await writesSavedPutHeld(
      cluster,
      "o-26b",
      FaultStepPoint.ChargeAfter,
    );
    expectThat(
      cluster,
      statusesOf(cluster, "charged", a) === "ran" && eventsOf(cluster, "charged", b).length === 0,
      `the charge was to run once, on a; a: ${statusesOf(cluster, "charged", a)}, b: ${statusesOf(cluster, "charged", b)}`,
    );
    expectThat(
      cluster,
      chargesOf(cluster, orderId) === "b",
      `the gateway's payments came from ${chargesOf(cluster, orderId)}, not b only`,
    );
    return b;
  },
};
