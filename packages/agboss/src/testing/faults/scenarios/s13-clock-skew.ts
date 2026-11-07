import { EXECUTION_LEASE } from "../../../app/lease-fence.js";
import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import type { FaultCluster } from "../cluster.js";
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
 * Scenarios 13 (#533 AC4): pods whose clocks disagree. Every pod's stores decide a lease's expiry by
 * the run's time — the database's —, and each holder fences itself on its own elapsed time, so a
 * pod's wall clock ten leases off changes nothing: one ahead never takes a live holder's lease, one
 * behind takes a frozen holder's lease on time.
 */

/** Ten leases, in the pods' time. */
const TEN_LEASES = 10 * EXECUTION_LEASE;

/** Two sweep periods of the pods' time (30 s each), in real time. */
const twoSweeps = (cluster: FaultCluster): Promise<void> =>
  systemClock.sleep(waitOf((2 * EXECUTION_LEASE) / cluster.options.timeScale));

export const s13ClockAhead: RunnableFaultScenario = {
  id: "s13-clock-ahead",
  title:
    "13: a pod's clock ten leases ahead — it never takes the lease a live pod holds and renews; that pod charges once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-13a");
    const order = await startOrder(cluster, a, "o-13a");
    const held = await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-13a");
    const b = await cluster.pod("b", { clockSkew: { offset: TEN_LEASES } });
    // b's sweeps look for the running tree while a holds it, renewing
    await twoSweeps(cluster);
    await release(a, held);
    await endedOn(cluster, order.rootExecutionId, a);
    const takeovers = eventsOf(cluster, "takeover", b);
    expectThat(cluster, takeovers.length === 0, `b, ahead, took ${String(takeovers.length)} leases`);
    const charges = eventsOf(cluster, "charged");
    expectThat(cluster, charges.length === 1, `${String(charges.length)} charges, not one`);
    return a;
  },
};

export const s13ClockBehind: RunnableFaultScenario = {
  id: "s13-clock-behind",
  title:
    "13: a pod's clock ten leases behind — it takes a frozen pod's tree over on time, from its last checkpoint",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-13b");
    const order = await startOrder(cluster, a, "o-13b");
    await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-13b");
    a.freeze();
    const b = await cluster.pod("b", { clockSkew: { offset: -TEN_LEASES } });
    const takeover = await takenOverBy(cluster, b, order.rootExecutionId);
    expectThat(
      cluster,
      takeover.previousHolderInstanceId === a.instanceId,
      `b took the tree over from ${String(takeover.previousHolderInstanceId)}, not from a`,
    );
    await endedOn(cluster, order.rootExecutionId, b);
    await a.kill();
    return b;
  },
};
