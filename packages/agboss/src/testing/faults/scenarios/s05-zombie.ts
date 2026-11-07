import { OperationPhase } from "../operation-history.js";
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
 * Scenario 5 (#484, #471, #500): the original pod comes back. Pod a reaches its charge's fenced
 * write and is frozen (SIGSTOP) there, before the store is asked. Its lease expires and pod b takes
 * the tree over. When a is thawed (SIGCONT) and its write goes on, the store refuses it — its token
 * is stale — so it hands over, and nothing is undone. Two orders: b's write first (5a), or the
 * zombie's first, before the new holder's (5b) — refused all the same. 5c (#584, #505): the same
 * zombie at the payment's first fenced write (`outboundCall.saveIfAbsent`, the intent recorded
 * before the gateway is called), reaching the outbound-call store before the new holder's.
 */

/** A fenced write a zombie is frozen at: the charge's (5, 5b) or the payment's intent (5c). */
type ZombieWrite = StoreHoldPoint.FencedEffectWrite | StoreHoldPoint.OutboundSaveIfAbsent;

/** How pod `pod`'s fenced write `point` of `key` ended, from the history. */
function writeOutcome(cluster: FaultCluster, pod: FaultPod, key: string, point: ZombieWrite): string {
  const write = cluster.history.events.find(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.process === pod.name &&
      event.operation === point &&
      event.key === key,
  );
  if (write === undefined) return "no answer";
  return write.error === undefined
    ? `accepted (${JSON.stringify(write.output)})`
    : write.error.name;
}

/** Until pod `pod`'s fenced write `point` of `key` was answered. */
const writeAnswered = (
  cluster: FaultCluster,
  pod: FaultPod,
  key: string,
  point: ZombieWrite,
): Promise<unknown> =>
  cluster.next(
    `the answer to ${pod.name}'s ${point} of ${key}`,
    () => writeOutcome(cluster, pod, key, point) !== "no answer",
  );

/** Pod a frozen at its write `point`, b holding the tree; `zombieFirst`: b held at its own too. */
async function zombie(
  cluster: FaultCluster,
  orderId: string,
  zombieFirst: boolean,
  point: ZombieWrite = StoreHoldPoint.FencedEffectWrite,
): Promise<FaultPod> {
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  await holdStore(a, point, undefined);
  if (zombieFirst) await holdStore(b, point, undefined);
  const order = await startOrder(cluster, a, orderId);
  const key = order.rootExecutionId;
  const frozen = await heldAt(cluster, a, point, key);
  a.freeze();
  await takenOverBy(cluster, b, key);
  if (zombieFirst) {
    const second = await heldAt(cluster, b, point, key);
    a.thaw();
    await release(a, frozen);
    await writeAnswered(cluster, a, key, point);
    await release(b, second);
  } else {
    await endedOn(cluster, key, b);
    a.thaw();
    await release(a, frozen);
    await writeAnswered(cluster, a, key, point);
  }
  await cluster.ended(key);
  const outcome = writeOutcome(cluster, a, key, point);
  expectThat(
    cluster,
    outcome === "ExecutionFencedError",
    `the zombie's write was to be refused (ExecutionFencedError); it was ${outcome}`,
  );
  await cluster.next("a's hand-over", (event) => event.type === "handed-over" && event.pod === "a");
  expectThat(
    cluster,
    eventsOf(cluster, "released").length === 0,
    "the hand-over undid the reservation",
  );
  return b;
}

export const s05ZombieAfter: RunnableFaultScenario = {
  id: "s05-zombie-write-refused",
  title:
    "5: a frozen pod (SIGSTOP → SIGCONT) comes back after the new holder's charge — its stale write is refused, it hands over, nothing is undone",
  run: (cluster) => zombie(cluster, "o-5", false),
};

export const s05ZombieFirst: RunnableFaultScenario = {
  id: "s05b-zombie-reaches-charge-first",
  title:
    "5b: the zombie reaches the charge before the new holder — refused by the store's lease check; the new holder charges once",
  run: (cluster) => zombie(cluster, "o-5b", true),
};

export const s05ZombiePaysFirst: RunnableFaultScenario = {
  id: "s05c-zombie-reaches-payment-first",
  title:
    "5c: the zombie reaches the payment's intent before the new holder — refused by the outbound-call store's lease check; one payment",
  run: (cluster) => zombie(cluster, "o-5c", true, StoreHoldPoint.OutboundSaveIfAbsent),
};
