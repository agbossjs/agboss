import { EXECUTION_LEASE } from "../../../app/lease-fence.js";
import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import { LeaseTakeoverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { HoldPhase } from "../hold-points.js";
import { StoreHoldPoint } from "../store-points.js";
import type { FaultScenario } from "../scenario.js";
import type { FaultWorld } from "../world.js";
import type { FaultPod } from "../pod.js";
import {
  eventsOf,
  expectThat,
  heldAt,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 12b (#607, #340 PR 4): an undo marked done is never run again. The order's charge
 * declines for real; pod a undoes the reservation and writes its done mark
 * (`@agboss/compensated/<key>`), and is frozen (SIGSTOP) right after the tree's store answered —
 * before its tree is failed. Its lease expires; pod b takes the tree over (`Unwinding`), finds the
 * undo marked done and fails the tree without releasing again. a is thawed (SIGCONT) and stops at
 * its own fence. The reservation is released once, by a.
 */

/** The family of every undo's done mark (`tree-points.ts`). */
const DONE_MARK = "@agboss/compensated";

async function markedUndo(world: FaultWorld): Promise<FaultPod> {
  const orderId = "o-12b";
  const a = await world.pod("a");
  const b = await world.pod("b");
  await holdStore(a, StoreHoldPoint.TreeSaveIfAbsent, DONE_MARK, { phase: HoldPhase.After });
  const order = await startOrder(world, a, orderId, { decline: true });
  const frozen = await heldAt(world, a, StoreHoldPoint.TreeSaveIfAbsent, DONE_MARK);
  a.stop();
  const takeover = await takenOverBy(world, b, order.rootExecutionId);
  expectThat(
    world,
    takeover.reason === LeaseTakeoverReason.Unwinding,
    `b's takeover was ${String(takeover.reason)}`,
  );
  const end = await world.ended(order.rootExecutionId);
  expectThat(
    world,
    end.type === "failed" && end.pod === "b",
    `the declined tree ${end.type === "failed" ? "failed" : "ended"} on ${end.pod}`,
  );
  a.cont();
  await release(a, frozen);
  // a goes on past its lease: two leases of its time for whatever it would still do
  await systemClock.sleep(waitOf((2 * EXECUTION_LEASE) / world.options.timeScale));
  const released = eventsOf(world, "released").map((event) => event.pod);
  expectThat(
    world,
    released.join() === "a",
    `the reservation was to be released once, by a; it was on [${released.join(", ")}]`,
  );
  return b;
}

export const s12bMarkedUndo: FaultScenario = {
  id: "s12b-marked-undo-not-again",
  title:
    "12b: a pod frozen once its undo is marked done — the next pod ends the tree without undoing it again; released once",
  run: markedUndo,
};
