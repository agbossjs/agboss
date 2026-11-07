import { HoldPhase } from "../hold-points.js";
import { StoreHoldPoint } from "../store-points.js";
import type { RunnableFaultScenario } from "../scenario.js";
import type { FaultCluster } from "../cluster.js";
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
const chargesOf = (cluster: FaultCluster, orderId: string): readonly string[] =>
  cluster.gateway.requests
    .filter((request) => request.orderId === orderId)
    .map((request) => request.pod);

async function recordedNotSent(cluster: FaultCluster): Promise<FaultPod> {
  const orderId = "o-5d";
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  await holdStore(a, StoreHoldPoint.OutboundSaveIfAbsent, undefined, { phase: HoldPhase.After });
  const order = await startOrder(cluster, a, orderId);
  const key = order.rootExecutionId;
  const frozen = await heldAt(cluster, a, StoreHoldPoint.OutboundSaveIfAbsent, key);
  a.freeze();
  await takenOverBy(cluster, b, key);
  await endedOn(cluster, key, b);
  a.thaw();
  await release(a, frozen);
  await cluster.next("a's hand-over", (event) => event.type === "handed-over" && event.pod === "a");
  const charges = chargesOf(cluster, orderId);
  expectThat(
    cluster,
    charges.length === 1 && charges[0] === "b",
    `the payment was to reach the gateway once, from b; it did from [${charges.join(", ")}]`,
  );
  expectThat(
    cluster,
    eventsOf(cluster, "paid", a).length === 0,
    "the zombie paid after its lease was taken over",
  );
  expectThat(
    cluster,
    eventsOf(cluster, "released").length === 0,
    "the hand-over undid the reservation",
  );
  return b;
}

export const s05ZombieRecordedNotSent: RunnableFaultScenario = {
  id: "s05d-zombie-recorded-not-sent",
  title:
    "5d: a zombie frozen between its payment's intent and its send — the new holder reconciles and pays once; the zombie's send is refused",
  run: recordedNotSent,
};
