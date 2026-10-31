import { HandOverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  holdStore,
  startOrder,
  stoppedAt,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 4 (#484, #335): a lease expires while its pod lives — its renewals stall at the store
 * (held), as on an overloaded database. The pod trusts its lease only up to its last confirmed
 * renewal: past it, its step stops and hands over (`LeaseLost`) without charging. Another pod
 * takes the expired lease over and finishes the tree; the stalled renewals, let go, are refused.
 */
export const s04LeaseExpiry: FaultScenario = {
  id: "s04-lease-expires",
  title:
    "4: a lease expires (its renewals stall) — its pod stops the step and hands over, another pod takes the tree over",
  run: async (world) => {
    const a = await world.pod("a");
    const b = await world.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-4");
    const order = await startOrder(world, a, "o-4");
    await heldStep(world, a, FaultStepPoint.ChargeBefore, "o-4");
    // the store stalls a's renewals, and its own sweep's take: the tree goes to another pod
    await holdStore(a, StoreHoldPoint.LeaseRenew, order.rootExecutionId, { times: 1000 });
    await holdStore(a, StoreHoldPoint.LeaseAcquire, order.rootExecutionId, { times: 1000 });
    await stoppedAt(world, a, FaultStepPoint.ChargeBefore, "o-4");
    const takeover = await takenOverBy(world, b, order.rootExecutionId);
    expectThat(
      world,
      takeover.previousHolderInstanceId === a.instanceId,
      `b took the lease over from ${String(takeover.previousHolderInstanceId)}`,
    );
    await a.command({ op: "release-all" });
    await endedOn(world, order.rootExecutionId, b);
    const reasons = eventsOf(world, "handed-over", a).map((event) => event.reason);
    expectThat(
      world,
      reasons.includes(HandOverReason.LeaseLost),
      `a's hand-overs: ${reasons.join(", ")}`,
    );
    expectThat(
      world,
      eventsOf(world, "charged", a).length === 0,
      "a charged after its lease expired",
    );
    return b;
  },
};
