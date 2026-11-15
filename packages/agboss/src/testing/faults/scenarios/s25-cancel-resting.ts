import { HoldPhase } from "../hold-points.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { eventsOf, expectThat, heldAt, holdStore } from "./kit.js";
import { pausedOrderOn, pauseStateOn, type PausedOrder } from "./pause-kit.js";

/**
 * Scenario 25 (#1132, #939 AC3): a pod killed in the middle of `app.cancel` of a resting tree. The
 * order rests at its pause on pod a; pod b cancels it and is killed (SIGKILL) at a step of the cancel,
 * and the other pod finishes the end: the order ends cancelled, its pause `cancelled`, its paused run
 * gone, nothing charged or paid after the cancel (`no-effect-after-cancel`).
 * - 25, dropped: b is killed right after its cancel removed the tree's paused run — the root's record
 *   already moved off `paused` (the end marks it first), so the recovery sweep of pod a finishes the
 *   end; before #1132 the run was removed first and the pause stayed open for good;
 * - 25b, requested: b is killed right after its cancel made its request durable, before anything of
 *   the end — the tree rests, and a second cancel on pod a answers `true` and ends it;
 * - 25c, swept (#1152): the same kill, and nobody cancels again — the recovery sweep of pod a reads
 *   the tree's cancel mark on its lease row and ends the order cancelled on its own.
 */

/** The thread an order of `pausedOrderOn` rests on. */
const threadOf = (order: PausedOrder): string => `thread-${order.orderId}`;

/** The tree, read on `pod`: ended as a cancel, its pauses closed, its paused run gone. */
async function expectEndedCancelled(
  cluster: FaultCluster,
  pod: FaultPod,
  order: PausedOrder,
): Promise<void> {
  const state = await pauseStateOn(pod, order.rootExecutionId);
  expectThat(
    cluster,
    state.pauses.length > 0 && state.pauses.every((pause) => pause.status === "cancelled"),
    `${order.orderId}'s pauses were to be cancelled, they are ${JSON.stringify(state.pauses)}`,
  );
  expectThat(
    cluster,
    !state.hasPausedRun && state.rootStatus === "failed",
    `${order.orderId} was to end failed with no paused run, it is ${JSON.stringify({ root: state.rootStatus, run: state.hasPausedRun })}`,
  );
  expectThat(
    cluster,
    eventsOf(cluster, "step").every(
      (event) => event.orderId !== order.orderId || event.point !== "charge.after",
    ),
    `${order.orderId} was charged after its cancel`,
  );
}

/**
 * Scenario 25's run, with a place for a test to arm something once the order rests on pod a and
 * before the cancel (#1178: a delivery held, to prove the run waits for the notices it checks).
 */
export async function runDropped(
  cluster: FaultCluster,
  restedOn: (a: FaultPod, order: PausedOrder) => Promise<void> = () => Promise.resolve(),
): Promise<FaultPod> {
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  const order = await pausedOrderOn(cluster, a, "o-25", undefined, { cancelled: true });
  await restedOn(a, order);
  await holdStore(b, StoreHoldPoint.PausedRunDelete, order.rootExecutionId, {
    phase: HoldPhase.After,
  });
  await b.command({ op: "cancel", tag: "cancel-25", threadId: threadOf(order) });
  await heldAt(cluster, b, StoreHoldPoint.PausedRunDelete, order.rootExecutionId);
  await b.kill();
  await cluster.ended(order.rootExecutionId);
  await expectEndedCancelled(cluster, a, order);
  return a;
}

export const s25Dropped: RunnableFaultScenario = {
  id: "s25-cancel-resting-kill-after-drop",
  title:
    "25: a pod killed right after its app.cancel removed a resting tree's paused run — another pod's sweep ends the order cancelled, its pause closed",
  run: (cluster) => runDropped(cluster),
};

export const s25bRequested: RunnableFaultScenario = {
  id: "s25b-cancel-resting-kill-after-request",
  title:
    "25b: a pod killed right after its app.cancel of a resting tree made the cancel durable — a second cancel on another pod ends the order cancelled and says so",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-25b", undefined, { cancelled: true });
    await holdStore(b, StoreHoldPoint.LeaseRequestCancel, order.rootExecutionId, {
      phase: HoldPhase.After,
    });
    await b.command({ op: "cancel", tag: "cancel-25b", threadId: threadOf(order) });
    await heldAt(cluster, b, StoreHoldPoint.LeaseRequestCancel, order.rootExecutionId);
    await b.kill();
    await a.command({ op: "cancel", tag: "cancel-25b-again", threadId: threadOf(order) });
    const again = await cluster.next(
      "the second cancel answered",
      (event) => event.type === "cancelled" && event.tag === "cancel-25b-again",
    );
    expectThat(
      cluster,
      again.cancelled === true,
      `the second cancel was to end the tree, it answered ${JSON.stringify(again.cancelled)}`,
    );
    await cluster.ended(order.rootExecutionId);
    await expectEndedCancelled(cluster, a, order);
    return a;
  },
};

export const s25cSwept: RunnableFaultScenario = {
  id: "s25c-cancel-resting-kill-after-request-swept",
  title:
    "25c: a pod killed right after its app.cancel of a resting tree made the cancel durable, nobody cancels again — another pod's sweep reads the mark and ends the order cancelled",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-25c", undefined, { cancelled: true });
    await holdStore(b, StoreHoldPoint.LeaseRequestCancel, order.rootExecutionId, {
      phase: HoldPhase.After,
    });
    await b.command({ op: "cancel", tag: "cancel-25c", threadId: threadOf(order) });
    await heldAt(cluster, b, StoreHoldPoint.LeaseRequestCancel, order.rootExecutionId);
    await b.kill();
    await cluster.ended(order.rootExecutionId);
    await expectEndedCancelled(cluster, a, order);
    return a;
  },
};
