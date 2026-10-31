import { OperationPhase } from "../operation-history.js";
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
function writeOutcome(world: FaultWorld, pod: FaultPod, key: string, point: ZombieWrite): string {
  const write = world.history.events.find(
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
  world: FaultWorld,
  pod: FaultPod,
  key: string,
  point: ZombieWrite,
): Promise<unknown> =>
  world.next(
    `the answer to ${pod.name}'s ${point} of ${key}`,
    () => writeOutcome(world, pod, key, point) !== "no answer",
  );

/** Pod a frozen at its write `point`, b holding the tree; `zombieFirst`: b held at its own too. */
async function zombie(
  world: FaultWorld,
  orderId: string,
  zombieFirst: boolean,
  point: ZombieWrite = StoreHoldPoint.FencedEffectWrite,
): Promise<FaultPod> {
  const a = await world.pod("a");
  const b = await world.pod("b");
  await holdStore(a, point, undefined);
  if (zombieFirst) await holdStore(b, point, undefined);
  const order = await startOrder(world, a, orderId);
  const key = order.rootExecutionId;
  const frozen = await heldAt(world, a, point, key);
  a.stop();
  await takenOverBy(world, b, key);
  if (zombieFirst) {
    const second = await heldAt(world, b, point, key);
    a.cont();
    await release(a, frozen);
    await writeAnswered(world, a, key, point);
    await release(b, second);
  } else {
    await endedOn(world, key, b);
    a.cont();
    await release(a, frozen);
    await writeAnswered(world, a, key, point);
  }
  await world.ended(key);
  const outcome = writeOutcome(world, a, key, point);
  expectThat(
    world,
    outcome === "ExecutionFencedError",
    `the zombie's write was to be refused (ExecutionFencedError); it was ${outcome}`,
  );
  await world.next("a's hand-over", (event) => event.type === "handed-over" && event.pod === "a");
  expectThat(
    world,
    eventsOf(world, "released").length === 0,
    "the hand-over undid the reservation",
  );
  return b;
}

export const s05ZombieAfter: FaultScenario = {
  id: "s05-zombie-write-refused",
  title:
    "5: a frozen pod (SIGSTOP → SIGCONT) comes back after the new holder's charge — its stale write is refused, it hands over, nothing is undone",
  run: (world) => zombie(world, "o-5", false),
};

export const s05ZombieFirst: FaultScenario = {
  id: "s05b-zombie-reaches-charge-first",
  title:
    "5b: the zombie reaches the charge before the new holder — refused by the store's lease check; the new holder charges once",
  run: (world) => zombie(world, "o-5b", true),
};

export const s05ZombiePaysFirst: FaultScenario = {
  id: "s05c-zombie-reaches-payment-first",
  title:
    "5c: the zombie reaches the payment's intent before the new holder — refused by the outbound-call store's lease check; one payment",
  run: (world) => zombie(world, "o-5c", true, StoreHoldPoint.OutboundSaveIfAbsent),
};
