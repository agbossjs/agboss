import { LeaseTakeoverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultScenario } from "../scenario.js";
import { eventsOf, expectThat, heldStep, holdStep, startOrder, takenOverBy } from "./kit.js";

/**
 * Scenario 12 (#484, #340): compensation only on a real failure — the other side of crash
 * recovery. The order's charge declines for real: the tree fails and its reservation is undone.
 * The pod running the undo is killed in it; the pod that takes the tree over finishes the undo
 * (`Unwinding`), and the reservation is released once. A hand-over never undoes (scenarios 1–11);
 * a real failure always does, exactly once.
 */
export const s12RealFailure: FaultScenario = {
  id: "s12-real-failure-undone-once",
  title:
    "12: a real failure undoes the reservation — killed mid-undo, the next pod finishes the undo, once",
  run: async (world) => {
    const a = await world.pod("a");
    const b = await world.pod("b");
    await holdStep(a, FaultStepPoint.Release, "o-12");
    const order = await startOrder(world, a, "o-12", { decline: true });
    await heldStep(world, a, FaultStepPoint.Release, "o-12");
    await a.kill();
    const takeover = await takenOverBy(world, b, order.rootExecutionId);
    expectThat(
      world,
      takeover.reason === LeaseTakeoverReason.Unwinding,
      `b's takeover was ${String(takeover.reason)}`,
    );
    const end = await world.ended(order.rootExecutionId);
    expectThat(
      world,
      end.type === "failed" && end.pod === "b",
      `the declined tree ${end.type === "failed" ? "failed" : "ended"} on ${end.pod}`,
    );
    const released = eventsOf(world, "released").map((event) => event.pod);
    expectThat(
      world,
      released.join() === "b",
      `the reservation was released on ${released.join(", ")}`,
    );
    return b;
  },
};
