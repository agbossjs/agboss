import { HoldPhase } from "../hold-points.js";
import type { FaultCluster } from "../cluster.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, expectThat, heldAt, holdStore } from "./kit.js";
import { answerOn, pausedOrderOn, type PausedOrder } from "./pause-kit.js";

/**
 * Scenario 21 (#940): a pod killed around a pause's notice — the listener (the fixture's webhook
 * fake) must be told, at least once and never zero times, whatever the pod that wrote the notice
 * was doing when it died. Each time the order is reserved once, charged once, paid once and
 * finishes, and the invariant `notices-once-each-in-order` holds: every pause closed was told
 * `opened` then `closed`, a notice told twice under one `deliveryId`.
 * - 21, claimed: pod b answers the pause (the close commits with its notice) and is killed holding
 *   the claim of the notice, before it delivered; pod a delivers it once the claim lapsed;
 * - 21b, delivered: pod b delivers the notice and is killed before it acknowledged it; pod a
 *   delivers it again, with the same `deliveryId`;
 * - 21c, committed: pod b is killed right after its resume committed the answer; pod a delivers
 *   the notice written with it.
 */

/** The mailbox of the fixture's listener for `order`'s pause, as a hold point keys it. */
const mailboxOf = (order: PausedOrder): string => `listener:fault-pause-listener:${order.pauseId}`;

/** The listener has been told `notice` of the pause: its key is the one of the order's tenant and pause. */
const told = (cluster: FaultCluster, order: PausedOrder, notice: string, nth = 1) =>
  cluster.nth(
    `${order.orderId}'s pause told ${notice} (${String(nth)})`,
    (event) => event.type === "pause-notice" && event.notice === notice,
    nth,
  );

/** The deliveries of `notice` the listener told, as `[pod, deliveryId]`, in the order heard. */
const deliveries = (cluster: FaultCluster, notice: string): readonly (readonly string[])[] =>
  cluster.events
    .filter((event) => event.type === "pause-notice" && event.notice === notice)
    .map((event) => [event.pod, String(event.deliveryId)]);

/** The pause is told `opened` by the pod that rested it, before anything answers it. */
async function restedAndOpened(cluster: FaultCluster, order: PausedOrder): Promise<void> {
  await told(cluster, order, "opened");
}

export const s21Claimed: RunnableFaultScenario = {
  id: "s21-pause-notice-kill-after-claim",
  title:
    "21: a pod killed holding the claim of a pause's closed notice — another pod delivers it once the claim lapsed, the order finishes charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-21");
    await restedAndOpened(cluster, order);
    await holdStore(b, StoreHoldPoint.PauseNoticeClaim, undefined, { phase: HoldPhase.After });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseNoticeClaim);
    await b.kill();
    await endedOn(cluster, order.rootExecutionId, a);
    await told(cluster, order, "closed");
    const closed = deliveries(cluster, "closed").map(([pod]) => pod);
    expectThat(
      cluster,
      closed.join() === "a",
      `closed was delivered by ${closed.join(", ")}, not by a alone`,
    );
    return a;
  },
};

export const s21bDelivered: RunnableFaultScenario = {
  id: "s21b-pause-notice-kill-after-delivery",
  title:
    "21b: a pod killed after it delivered a pause's closed notice, before it acknowledged it — another pod delivers it again under the same deliveryId",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-21b");
    await restedAndOpened(cluster, order);
    await holdStore(b, StoreHoldPoint.PauseNoticeAck, mailboxOf(order));
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseNoticeAck, mailboxOf(order));
    await b.kill();
    await endedOn(cluster, order.rootExecutionId, a);
    await told(cluster, order, "closed", 2);
    const closed = deliveries(cluster, "closed");
    const ids = new Set(closed.map(([, id]) => id));
    expectThat(
      cluster,
      closed[0]?.[0] === "b" && closed[1]?.[0] === "a",
      `closed was delivered by ${closed.map(([pod]) => pod).join(", ")}, b then a expected`,
    );
    expectThat(
      cluster,
      ids.size === 1,
      `the redelivery carried ${String(ids.size)} deliveryIds, one expected`,
    );
    return a;
  },
};

export const s21cCommitted: RunnableFaultScenario = {
  id: "s21c-pause-notice-kill-after-resolve",
  title:
    "21c: a pod killed right after its resume committed the answer — another pod delivers the notice written with it, the order finishes charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-21c");
    await restedAndOpened(cluster, order);
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.After });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    await b.kill();
    await endedOn(cluster, order.rootExecutionId, a);
    await told(cluster, order, "closed");
    return a;
  },
};
