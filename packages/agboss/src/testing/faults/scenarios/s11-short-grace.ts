import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultPod, PodExit } from "../pod.js";
import type { FaultScenario } from "../scenario.js";
import type { FaultWorld } from "../world.js";
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

/** The platform's stop: SIGTERM, then SIGKILL unless the pod exited within the grace. */
async function platformStop(world: FaultWorld, pod: FaultPod): Promise<PodExit> {
  pod.term();
  const grace = waitOf(PLATFORM_GRACE / world.options.timeScale);
  const inTime = await Promise.race([pod.exited, systemClock.sleep(grace).then(() => undefined)]);
  return inTime ?? (await pod.kill());
}

/** A pod with `shutdownTimeout` stopped by the platform mid-step; b finishes the tree. */
async function stoppedMidStep(
  world: FaultWorld,
  orderId: string,
  shutdownTimeout: Milliseconds,
): Promise<{ readonly b: FaultPod; readonly exit: PodExit }> {
  const a = await world.pod("a", { shutdownTimeout });
  const b = await world.pod("b");
  await holdStep(a, FaultStepPoint.ChargeBefore, orderId);
  const order = await startOrder(world, a, orderId);
  await heldStep(world, a, FaultStepPoint.ChargeBefore, orderId);
  const exit = await platformStop(world, a);
  await takenOverBy(world, b, order.rootExecutionId);
  await endedOn(world, order.rootExecutionId, b);
  return { b, exit };
}

export const s11InGrace: FaultScenario = {
  id: "s11-short-grace",
  title:
    "11: SIGTERM with a 10 s grace and shutdownTimeout below it — the pod hands over and exits in time, nothing is lost",
  run: async (world) => {
    const { b, exit } = await stoppedMidStep(world, "o-11", seconds(8));
    expectThat(
      world,
      exit.code === 0 && exit.signal === null,
      `a was to exit by itself within the grace; it ended ${JSON.stringify(exit)}`,
    );
    return b;
  },
};

export const s11Misconfigured: FaultScenario = {
  id: "s11b-shutdown-timeout-above-grace",
  title:
    "11b: shutdownTimeout above the grace — the platform kills the pod mid-drain, the tree is taken over, the charge once",
  run: async (world) => {
    const { b, exit } = await stoppedMidStep(world, "o-11b", seconds(60));
    expectThat(
      world,
      exit.signal === "SIGKILL",
      `a was to be killed at the end of the grace; it ended ${JSON.stringify(exit)}`,
    );
    return b;
  },
};
