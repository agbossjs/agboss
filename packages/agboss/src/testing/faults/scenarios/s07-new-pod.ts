import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultScenario } from "../scenario.js";
import { chargePodsOf, heldChildOn, startBatch } from "./batch-kit.js";
import { endedOn, expectThat, holdStep } from "./kit.js";

/**
 * Scenario 7 (#484, #333): a new pod joins and claims pending work. Pod a runs a batch of two
 * orders with one step slot: its first child holds the slot, the second waits in the queue. Pod b
 * starts, claims the waiting child and runs it — before a's first child is let go.
 */
export const s07NewPod: FaultScenario = {
  id: "s07-new-pod-claims-pending",
  title:
    "7: a new pod joins — it claims the queued child the busy pod cannot run, each child runs once",
  run: async (world) => {
    const a = await world.pod("a", { maxConcurrentSteps: 1 });
    await holdStep(a, FaultStepPoint.ChargeBefore);
    const batch = await startBatch(world, a, ["o-7a", "o-7b"]);
    const onA = await heldChildOn(world, a);
    const b = await world.pod("b", { maxConcurrentSteps: 1 });
    const waiting = batch.orderIds.find((orderId) => orderId !== onA.orderId) ?? "";
    await world.next(
      `the queued child ${waiting} paid on b`,
      (event) => event.type === "paid" && event.pod === "b" && event.orderId === waiting,
    );
    expectThat(
      world,
      chargePodsOf(world, waiting).join() === "b",
      `${waiting} was charged on ${chargePodsOf(world, waiting).join(", ")}`,
    );
    await a.command({ op: "release-all" });
    await endedOn(world, batch.rootExecutionId, a);
    expectThat(
      world,
      chargePodsOf(world, onA.orderId).join() === "a",
      `${onA.orderId} was charged on ${chargePodsOf(world, onA.orderId).join(", ")}`,
    );
    return b;
  },
};
