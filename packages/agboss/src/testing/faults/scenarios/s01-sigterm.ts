import { HandOverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { seconds } from "../../../units/index.js";
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
  stoppedAt,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 1 (#484): a pod gets SIGTERM during an active workflow and drains (`app.close()` with
 * its shutdown timeout). When its step ends within the timeout the work finishes there, and no
 * other pod takes anything over (1). When the step outlasts the timeout, the pod interrupts it,
 * hands it over and exits; another pod takes the tree over and finishes it, the charge once (1b).
 */
export const s01Drains: FaultScenario = {
  id: "s01-sigterm-drains",
  title:
    "1: SIGTERM during an active workflow — the pod drains, the work finishes there, nothing is taken over",
  run: async (world) => {
    const a = await world.pod("a", { shutdownTimeout: seconds(120) });
    const b = await world.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-1");
    const order = await startOrder(world, a, "o-1");
    const held = await heldStep(world, a, FaultStepPoint.ChargeBefore, "o-1");
    a.term();
    await a.next("SIGTERM", (event) => event.type === "signal");
    await release(a, held);
    await endedOn(world, order.rootExecutionId, a);
    const exit = await a.exited;
    expectThat(
      world,
      exit.code === 0,
      `a was to exit by itself once drained; it exited ${JSON.stringify(exit)}`,
    );
    expectThat(
      world,
      eventsOf(world, "takeover").length === 0,
      "a drained pod's tree was taken over",
    );
    return b;
  },
};

export const s01TakenOver: FaultScenario = {
  id: "s01b-sigterm-shorter-than-step",
  title:
    "1b: SIGTERM with a shutdown timeout shorter than the step — the step is handed over, another pod takes the tree over",
  run: async (world) => {
    const a = await world.pod("a", { shutdownTimeout: seconds(5) });
    const b = await world.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-1b");
    const order = await startOrder(world, a, "o-1b");
    await heldStep(world, a, FaultStepPoint.ChargeBefore, "o-1b");
    a.term();
    await stoppedAt(world, a, FaultStepPoint.ChargeBefore, "o-1b");
    const exit = await a.exited;
    expectThat(
      world,
      exit.code === 0,
      `a was to exit by itself after its timeout; it exited ${JSON.stringify(exit)}`,
    );
    const handedOver = eventsOf(world, "handed-over", a).map((event) => event.reason);
    expectThat(
      world,
      handedOver.includes(HandOverReason.ApplicationStopping),
      `a's hand-overs: ${handedOver.join(", ")}`,
    );
    await takenOverBy(world, b, order.rootExecutionId);
    await endedOn(world, order.rootExecutionId, b);
    return b;
  },
};
