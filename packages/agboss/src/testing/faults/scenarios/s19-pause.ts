import { LeaseTakeoverReason } from "../../../infrastructure/execution-audit-log.repository.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import { HoldPhase } from "../hold-points.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, heldAt, heldStep, holdStep, holdStore } from "./kit.js";
import { answerOn, pausedOrderOn } from "./pause-kit.js";

/**
 * Scenario 19 (#959, from #850's deviation): a kill around a pause — the tree rests at a question
 * its thread owner answers with `app.resume`, and a pod is killed (SIGKILL) while the tree is
 * paused, while its answer is being recorded, and while the resumed pass runs. Each time the order
 * is reserved once, charged once, paid once and finishes: a paused root is never lost, an answer
 * recorded is never lost, a resumed pass is taken over.
 * - 19, paused: pod a rests the tree and is killed; a resume on pod b finishes it;
 * - 19b, answering: a resume on pod b is frozen right after the store recorded the answer
 *   (`Resolved`; the root `running` again since its mark, #850) and b is killed; pod a's recovery
 *   continues the tree with the recorded answer — the answer is not asked for again;
 * - 19c, resuming: b's resumed pass is held at its charge and b is killed; pod a takes the tree over
 *   from b's expired lease and finishes it.
 */

export const s19Paused: RunnableFaultScenario = {
  id: "s19-pause-kill-paused",
  title:
    "19: a pod killed while its order's tree is paused — a resume on another pod finishes it, charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-19");
    const exit = await a.kill();
    expectThat(
      cluster,
      exit.signal === "SIGKILL",
      `pod a was to be killed, it exited ${JSON.stringify(exit)}`,
    );
    await answerOn(b, order.pauseId);
    await endedOn(cluster, order.rootExecutionId, b);
    const reserved = eventsOf(cluster, "reserved").map((event) => event.pod);
    expectThat(cluster, reserved.join() === "a", `the reservation ran on ${reserved.join(", ")}`);
    return b;
  },
};

export const s19bAnswering: RunnableFaultScenario = {
  id: "s19b-pause-kill-answering",
  title:
    "19b: a pod killed right after its resume recorded the answer — another pod's recovery continues the tree with it, charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-19b");
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.After });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    await b.kill();
    await endedOn(cluster, order.rootExecutionId, a);
    expectThat(
      cluster,
      eventsOf(cluster, "charged", b).length === 0,
      "b was killed before its pass charged anything",
    );
    return a;
  },
};

export const s19cResuming: RunnableFaultScenario = {
  id: "s19c-pause-kill-resuming",
  title:
    "19c: a pod killed while its resumed pass runs — another pod takes the tree over from its expired lease, charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-19c");
    await holdStep(b, FaultStepPoint.ChargeBefore, "o-19c");
    await answerOn(b, order.pauseId);
    await heldStep(cluster, b, FaultStepPoint.ChargeBefore, "o-19c");
    await b.kill();
    const takeover = await cluster.next(
      `a takes ${order.rootExecutionId} over`,
      (event) =>
        event.type === "takeover" &&
        event.pod === "a" &&
        event.leaseExecutionId === order.rootExecutionId,
    );
    expectThat(
      cluster,
      takeover.reason === LeaseTakeoverReason.Recovered &&
        takeover.previousHolderInstanceId === b.instanceId,
      `a's takeover was ${String(takeover.reason)} from ${String(takeover.previousHolderInstanceId)}, not recovered from b`,
    );
    await endedOn(cluster, order.rootExecutionId, a);
    return a;
  },
};
