import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultPod, PodExit } from "../pod.js";
import type { RunnableFaultScenario } from "../scenario.js";
import type { FaultCluster } from "../cluster.js";
import { endedOn, expectThat, heldStep, holdStep, startOrder, takenOverBy } from "./kit.js";

/**
 * Scenario 11 (#484, #488): a short grace period, as on Cloud Run — the platform sends SIGTERM,
 * then SIGKILL once its grace (10 s) is over. With `shutdownTimeout` below the grace, the pod
 * interrupts its step in time, hands it over and exits by itself; another pod finishes the tree
 * (11). Misconfigured — `shutdownTimeout` above the grace — the platform kills it mid-drain, and
 * still nothing is lost: the tree is taken over once its lease expired, the charge once (11b).
 */

/** The platform's grace between SIGTERM and SIGKILL (the pods' clock). */
export const PLATFORM_GRACE: Milliseconds = seconds(10);

/** The least real time the platform's grace lasts, whatever the pods' time scale. */
export const MIN_REAL_GRACE: Milliseconds = seconds(5);

/** The platform's stop: SIGTERM, then SIGKILL unless the pod exited within the grace. */
async function platformStop(cluster: FaultCluster, pod: FaultPod): Promise<PodExit> {
  pod.terminate();
  // the grace on the pods' clock, but never under 5 s of real time: a pod's exit after its
  // shutdown (its pool ended, its process gone) takes real time a faster clock does not shorten
  const grace = waitOf(Math.max(PLATFORM_GRACE / cluster.options.timeScale, MIN_REAL_GRACE));
  const inTime = await Promise.race([pod.exited, systemClock.sleep(grace).then(() => undefined)]);
  return inTime ?? (await pod.kill());
}

/** A pod with `shutdownTimeout` stopped by the platform mid-step; b finishes the tree. */
async function stoppedMidStep(
  cluster: FaultCluster,
  orderId: string,
  shutdownTimeout: Milliseconds,
): Promise<{ readonly b: FaultPod; readonly exit: PodExit }> {
  const a = await cluster.pod("a", { shutdownTimeout });
  const b = await cluster.pod("b");
  await holdStep(a, FaultStepPoint.ChargeBefore, orderId);
  const order = await startOrder(cluster, a, orderId);
  await heldStep(cluster, a, FaultStepPoint.ChargeBefore, orderId);
  const exit = await platformStop(cluster, a);
  await takenOverBy(cluster, b, order.rootExecutionId);
  await endedOn(cluster, order.rootExecutionId, b);
  return { b, exit };
}

export const s11InGrace: RunnableFaultScenario = {
  id: "s11-short-grace",
  title:
    "11: SIGTERM with a 10 s grace and shutdownTimeout below it — the pod hands over and exits in time, nothing is lost",
  run: async (cluster) => {
    const { b, exit } = await stoppedMidStep(cluster, "o-11", seconds(8));
    expectThat(
      cluster,
      exit.code === 0 && exit.signal === null,
      `a was to exit by itself within the grace; it ended ${JSON.stringify(exit)}`,
    );
    return b;
  },
};

export const s11Misconfigured: RunnableFaultScenario = {
  id: "s11b-shutdown-timeout-above-grace",
  title:
    "11b: shutdownTimeout above the grace — the platform kills the pod mid-drain, the tree is taken over, the charge once",
  run: async (cluster) => {
    const { b, exit } = await stoppedMidStep(cluster, "o-11b", seconds(120));
    expectThat(
      cluster,
      exit.signal === "SIGKILL",
      `a was to be killed at the end of the grace; it ended ${JSON.stringify(exit)}`,
    );
    return b;
  },
};
