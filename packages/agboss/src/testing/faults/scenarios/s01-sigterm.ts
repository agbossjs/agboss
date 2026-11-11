import { HandOverReason } from "../../../infrastructure/execution-audit-log.repository.js";
import { seconds } from "../../../units/index.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  release,
  startOrder,
  stoppedAt,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 1 (#484): a pod gets SIGTERM during an active workflow and drains (`app.close()` with
 * its shutdown timeout). When its step ends within the timeout the work finishes there, and no
 * other pod takes anything over (1). When the step outlasts the timeout, the pod interrupts it,
 * hands it over and exits; another pod takes the tree over and finishes it, the charge once (1b).
 */
export const s01Drains: RunnableFaultScenario = {
  id: "s01-sigterm-drains",
  title:
    "1: SIGTERM during an active workflow — the pod drains, the work finishes there, nothing is taken over",
  run: async (cluster) => {
    const a = await cluster.pod("a", { shutdownTimeout: seconds(120) });
    const b = await cluster.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-1");
    const order = await startOrder(cluster, a, "o-1");
    const held = await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-1");
    a.terminate();
    await a.next("SIGTERM", (event) => event.type === "signal");
    await release(a, held);
    await endedOn(cluster, order.rootExecutionId, a);
    const exit = await a.exited;
    expectThat(
      cluster,
      exit.code === 0,
      `a was to exit by itself once drained; it exited ${JSON.stringify(exit)}`,
    );
    expectThat(
      cluster,
      eventsOf(cluster, "takeover").length === 0,
      "a drained pod's tree was taken over",
    );
    return b;
  },
};

export const s01TakenOver: RunnableFaultScenario = {
  id: "s01b-sigterm-shorter-than-step",
  title:
    "1b: SIGTERM with a shutdown timeout shorter than the step — the step is handed over, another pod takes the tree over",
  run: async (cluster) => {
    const a = await cluster.pod("a", { shutdownTimeout: seconds(5) });
    const b = await cluster.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-1b");
    const order = await startOrder(cluster, a, "o-1b");
    await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-1b");
    a.terminate();
    await stoppedAt(cluster, a, FaultStepPoint.ChargeBefore, "o-1b");
    const exit = await a.exited;
    expectThat(
      cluster,
      exit.code === 0,
      `a was to exit by itself after its timeout; it exited ${JSON.stringify(exit)}`,
    );
    const handedOver = eventsOf(cluster, "handed-over", a).map((event) => event.reason);
    expectThat(
      cluster,
      handedOver.includes(HandOverReason.ApplicationStopping),
      `a's hand-overs: ${handedOver.join(", ")}`,
    );
    await takenOverBy(cluster, b, order.rootExecutionId);
    await endedOn(cluster, order.rootExecutionId, b);
    return b;
  },
};
