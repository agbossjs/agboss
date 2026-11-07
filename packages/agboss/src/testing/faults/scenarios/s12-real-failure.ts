import { LeaseTakeoverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { eventsOf, expectThat, heldStep, holdStep, startOrder, takenOverBy } from "./kit.js";

/**
 * Scenario 12 (#484, #340): compensation only on a real failure — the other side of crash
 * recovery. The order's charge declines for real: the tree fails and its reservation is undone.
 * The pod running the undo is killed in it; the pod that takes the tree over finishes the undo
 * (`Unwinding`), and the reservation is released once. A hand-over never undoes (scenarios 1–11);
 * a real failure always does, exactly once. Before it, an order declined and undone by its own
 * pass: its kept record lists the undo too (#635), which `no-undo-on-hand-over` checks.
 */
export const s12RealFailure: RunnableFaultScenario = {
  id: "s12-real-failure-undone-once",
  title:
    "12: a real failure undoes the reservation — killed mid-undo, the next pod finishes the undo, once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    // #635: one declined and undone by its own pass — its record lists the undo (no-undo-on-hand-over)
    const own = await startOrder(cluster, a, "o-12-own", { decline: true });
    const ownEnd = await cluster.ended(own.rootExecutionId);
    expectThat(
      cluster,
      ownEnd.type === "failed" && ownEnd.pod === "a",
      `the tree declined on a ${ownEnd.type === "failed" ? "failed" : "ended"} on ${ownEnd.pod}`,
    );
    await holdStep(a, FaultStepPoint.Release, "o-12");
    const order = await startOrder(cluster, a, "o-12", { decline: true });
    await heldStep(cluster, a, FaultStepPoint.Release, "o-12");
    await a.kill();
    const takeover = await takenOverBy(cluster, b, order.rootExecutionId);
    expectThat(
      cluster,
      takeover.reason === LeaseTakeoverReason.Unwinding,
      `b's takeover was ${String(takeover.reason)}`,
    );
    const end = await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      end.type === "failed" && end.pod === "b",
      `the declined tree ${end.type === "failed" ? "failed" : "ended"} on ${end.pod}`,
    );
    const released = eventsOf(cluster, "released")
      .filter((event) => event.orderId === "o-12")
      .map((event) => event.pod);
    expectThat(
      cluster,
      released.join() === "b",
      `the reservation was released on ${released.join(", ")}`,
    );
    return b;
  },
};
