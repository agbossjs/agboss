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
 * zombie's first, before the new holder's (5b) — refused all the same.
 */

/** How pod `pod`'s fenced write of `key` ended, from the history. */
function writeOutcome(world: FaultWorld, pod: FaultPod, key: string): string {
  const write = world.history.events.find(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.process === pod.name &&
      event.operation === StoreHoldPoint.FencedEffectWrite &&
      event.key === key,
  );
  if (write === undefined) return "no answer";
  return write.error === undefined
    ? `accepted (${JSON.stringify(write.output)})`
    : write.error.name;
}

/** Until pod `pod`'s fenced write of `key` was answered. */
const writeAnswered = (world: FaultWorld, pod: FaultPod, key: string): Promise<unknown> =>
  world.next(
    `the answer to ${pod.name}'s write of ${key}`,
    () => writeOutcome(world, pod, key) !== "no answer",
  );

/** Pod a frozen at its write, b holding the tree; `zombieFirst`: b held at its own write too. */
async function zombie(world: FaultWorld, orderId: string, zombieFirst: boolean): Promise<FaultPod> {
  const a = await world.pod("a");
  const b = await world.pod("b");
  await holdStore(a, StoreHoldPoint.FencedEffectWrite, undefined);
  if (zombieFirst) await holdStore(b, StoreHoldPoint.FencedEffectWrite, undefined);
  const order = await startOrder(world, a, orderId);
  const frozen = await heldAt(world, a, StoreHoldPoint.FencedEffectWrite, order.rootExecutionId);
  a.stop();
  await takenOverBy(world, b, order.rootExecutionId);
  if (zombieFirst) {
    const second = await heldAt(world, b, StoreHoldPoint.FencedEffectWrite, order.rootExecutionId);
    a.cont();
    await release(a, frozen);
    await writeAnswered(world, a, order.rootExecutionId);
    await release(b, second);
  } else {
    await endedOn(world, order.rootExecutionId, b);
    a.cont();
    await release(a, frozen);
    await writeAnswered(world, a, order.rootExecutionId);
  }
  await world.ended(order.rootExecutionId);
  const outcome = writeOutcome(world, a, order.rootExecutionId);
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
