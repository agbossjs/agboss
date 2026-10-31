import { HoldPhase } from "../hold-points.js";
import { StoreHoldPoint } from "../store-points.js";
import type { FaultScenario } from "../scenario.js";
import type { FaultWorld } from "../world.js";
import type { FaultPod } from "../pod.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldAt,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 5d (#608, #505): the zombie between the payment's intent and its send. Pod a records its
 * payment's intent (`Pending`, its attempt's owner) and is frozen (SIGSTOP) right after the
 * outbound-call store answered, before it calls the gateway. Its lease expires; pod b takes the
 * tree over, finds the pending intent of a lease that is no longer live, reconciles it with the
 * gateway (not sent), sends once and finishes the tree. a is thawed (SIGCONT) and goes on: its
 * renewal right before the send (`fence.confirmNow()`) is refused, so it hands over and never
 * reaches the gateway. One charge request, one payment.
 */

/** The gateway's charge requests of `orderId`, by pod. */
const chargesOf = (world: FaultWorld, orderId: string): readonly string[] =>
  world.gateway.requests
    .filter((request) => request.orderId === orderId)
    .map((request) => request.pod);

async function recordedNotSent(world: FaultWorld): Promise<FaultPod> {
  const orderId = "o-5d";
  const a = await world.pod("a");
  const b = await world.pod("b");
  await holdStore(a, StoreHoldPoint.OutboundSaveIfAbsent, undefined, { phase: HoldPhase.After });
  const order = await startOrder(world, a, orderId);
  const key = order.rootExecutionId;
  const frozen = await heldAt(world, a, StoreHoldPoint.OutboundSaveIfAbsent, key);
  a.stop();
  await takenOverBy(world, b, key);
  await endedOn(world, key, b);
  a.cont();
  await release(a, frozen);
  await world.next("a's hand-over", (event) => event.type === "handed-over" && event.pod === "a");
  const charges = chargesOf(world, orderId);
  expectThat(
    world,
    charges.length === 1 && charges[0] === "b",
    `the payment was to reach the gateway once, from b; it did from [${charges.join(", ")}]`,
  );
  expectThat(
    world,
    eventsOf(world, "paid", a).length === 0,
    "the zombie paid after its lease was taken over",
  );
  expectThat(
    world,
    eventsOf(world, "released").length === 0,
    "the hand-over undid the reservation",
  );
  return b;
}

export const s05ZombieRecordedNotSent: FaultScenario = {
  id: "s05d-zombie-recorded-not-sent",
  title:
    "5d: a zombie frozen between its payment's intent and its send — the new holder reconciles and pays once; the zombie's send is refused",
  run: recordedNotSent,
};
