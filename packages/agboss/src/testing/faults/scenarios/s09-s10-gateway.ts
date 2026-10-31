import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultScenario } from "../scenario.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenarios 9 and 10 (#484, #505, #508): calls to the payment gateway. A pod killed after its
 * request reached the gateway and before the answer came back leaves a pending intent; the pod
 * that takes the tree over reconciles it by the call's key — never resends it (9). The same order
 * paid by two executions, the first killed with its answer in flight: the second finds the
 * first's pending intent under a lease that moved on, reconciles it, and the recovered first
 * replays it — one payment, one request (10).
 */
export const s09CrashAfterSend: FaultScenario = {
  id: "s09-crash-after-send",
  title:
    "9: a crash after sending to the gateway, before its answer — reconciled by its key, not resent",
  run: async (world) => {
    const a = await world.pod("a");
    const b = await world.pod("b");
    world.gateway.holdAnswer("o-9");
    const reached = world.gateway.answerHeld("o-9");
    const order = await startOrder(world, a, "o-9");
    await reached;
    await a.kill();
    await takenOverBy(world, b, order.rootExecutionId);
    await endedOn(world, order.rootExecutionId, b);
    const paid = eventsOf(world, "paid").map((event) => `${event.pod}:${String(event.status)}`);
    expectThat(world, paid.join() === "b:reconciled", `the payment's outcomes: ${paid.join(", ")}`);
    return b;
  },
};

export const s10OneOrderTwoTrees: FaultScenario = {
  id: "s10-one-order-two-executions",
  title:
    "10: the same order paid by two executions, the first killed with its answer in flight — one payment",
  run: async (world) => {
    const a = await world.pod("a");
    const b = await world.pod("b");
    world.gateway.holdAnswer("o-10");
    const reached = world.gateway.answerHeld("o-10");
    const first = await startOrder(world, a, "o-10");
    await reached;
    // b's recovery of the first tree waits before its payment; the second tree pays meanwhile
    await holdStep(b, FaultStepPoint.PayBefore, "o-10");
    await a.kill();
    await takenOverBy(world, b, first.rootExecutionId);
    const recovered = await heldStep(world, b, FaultStepPoint.PayBefore, "o-10");
    const second = await startOrder(world, b, "o-10");
    await endedOn(world, second.rootExecutionId, b);
    await release(b, recovered);
    await endedOn(world, first.rootExecutionId, b);
    const paid = eventsOf(world, "paid")
      .map((event) => String(event.status))
      .sort();
    expectThat(
      world,
      paid.join() === "reconciled,replayed",
      `the payments' outcomes: ${paid.join(", ")}`,
    );
    return b;
  },
};
