import { LeaseTakeoverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
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
 * Scenario 2 (#484): a pod is killed (SIGKILL) mid-step — its reservation checkpointed, its charge
 * not begun. Its lease is never released; once it expired, another pod takes the tree over from
 * its last checkpoint: the reservation is not made again, the charge and the payment run there.
 */
export const s02Kill: RunnableFaultScenario = {
  id: "s02-sigkill-mid-step",
  title:
    "2: a pod killed (SIGKILL) mid-step — another takes the tree over from its last checkpoint",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-2");
    const order = await startOrder(cluster, a, "o-2");
    await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-2");
    const exit = await a.kill();
    expectThat(
      cluster,
      exit.signal === "SIGKILL",
      `pod a was to be killed, it exited ${JSON.stringify(exit)}`,
    );
    const takeover = await takenOverBy(cluster, b, order.rootExecutionId);
    expectThat(
      cluster,
      takeover.reason === LeaseTakeoverReason.Recovered,
      `b's takeover was ${String(takeover.reason)}`,
    );
    expectThat(
      cluster,
      takeover.previousHolderInstanceId === a.instanceId,
      `b took the tree over from ${String(takeover.previousHolderInstanceId)}, not from a`,
    );
    await endedOn(cluster, order.rootExecutionId, b);
    // the last checkpoint is after the reservation: it ran once, on a
    const reserved = eventsOf(cluster, "reserved").map((event) => event.pod);
    expectThat(
      cluster,
      reserved.join() === "a",
      `the reservation ran on ${reserved.join(", ")}, not once on a`,
    );
    return b;
  },
};
