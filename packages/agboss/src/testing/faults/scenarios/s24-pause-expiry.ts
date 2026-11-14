import { HoldPhase } from "../hold-points.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  answered,
  askedOf,
  FIXTURE_EXPIRING,
  firstToExpire,
  survivor,
  threePods,
} from "./expiry-kit.js";
import { expectThat, release } from "./kit.js";
import { pausedOrderOn, sampledTree } from "./pause-kit.js";

/**
 * Scenario 24 (#941, #910 I4-I6): a pod killed around the expiry of a pause. The order rests at a
 * question its owner never answers (30 s on the pods' clock): the pause expires, the channel
 * approves the order itself (`decide`), the order is charged and paid once. Three pods; the one
 * whose look takes the tree first is held at the store's expiry and then killed, frozen or left:
 * - 24, before the record: held right before the compare-and-set that records the expiry — its
 *   handler has run — and killed with the root `running` and the pause still pending (never a
 *   `paused` root beside a closed pause); another pod's recovery continues it, asks the channel
 *   again (a crash before the decision was recorded) and records one decision;
 * - 24b, after the record: killed right after the compare-and-set — the pause closed, the root
 *   `running`; the recovery continues with the closed pause and asks the channel no more;
 * - 24c, a zombie: frozen right before its compare-and-set, long enough for another pod to take the
 *   tree over, expire the pause and finish the order; when it wakes its compare-and-set is refused
 *   (`one-expiry-decision`).
 * - 24d (`s24d-pause-expiry-cancel.ts`): a cancel meanwhile — the order ends cancelled;
 * - 24e, once: no fault — three pods look at the same tick, the channel's decision is asked once.
 */

export const s24BeforeRecord: RunnableFaultScenario = {
  id: "s24-pause-expiry-kill-before-record",
  title:
    "24: a pod killed after its expiry's handler, before the record of the expiry — another pod expires the pause (the channel asked again), the order is charged and paid once",
  run: async (cluster) => {
    const pods = await threePods(cluster);
    const [a] = pods;
    if (a === undefined) throw new Error("no pod");
    const order = await pausedOrderOn(cluster, a, "o-24", FIXTURE_EXPIRING);
    const { holder } = await firstToExpire(cluster, pods, order, HoldPhase.Before);
    await sampledTree(
      cluster,
      survivor(pods, holder),
      order.rootExecutionId,
      "holder held before the record",
    );
    expectThat(
      cluster,
      askedOf(cluster, order).length === 1,
      "the channel was to be asked once before the record",
    );
    await holder.kill();
    await sampledTree(
      cluster,
      survivor(pods, holder),
      order.rootExecutionId,
      "holder killed before the record",
    );
    const end = await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      end.type === "end" && end.pod !== holder.name,
      `${order.rootExecutionId} was to end on another pod than ${holder.name}`,
    );
    expectThat(
      cluster,
      askedOf(cluster, order).length === 2,
      `the channel was asked ${String(askedOf(cluster, order).length)} times, 2 expected (a crash before the decision was recorded)`,
    );
    return survivor(pods, holder);
  },
};

export const s24bAfterRecord: RunnableFaultScenario = {
  id: "s24b-pause-expiry-kill-after-record",
  title:
    "24b: a pod killed right after the compare-and-set that records its expiry — another pod's recovery continues the tree with the closed pause, the channel asked once, the order charged and paid once",
  run: async (cluster) => {
    const pods = await threePods(cluster);
    const [a] = pods;
    if (a === undefined) throw new Error("no pod");
    const order = await pausedOrderOn(cluster, a, "o-24b", FIXTURE_EXPIRING);
    const { holder } = await firstToExpire(cluster, pods, order, HoldPhase.After);
    const state = await sampledTree(
      cluster,
      survivor(pods, holder),
      order.rootExecutionId,
      "holder killed after the record",
    );
    expectThat(
      cluster,
      state.pauses.every((pause) => pause.status !== "pending"),
      "the pause was to be closed by the record",
    );
    await holder.kill();
    const end = await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      end.type === "end" && end.pod !== holder.name,
      `${order.rootExecutionId} was to end on another pod`,
    );
    expectThat(
      cluster,
      askedOf(cluster, order).length === 1,
      `the channel was asked ${String(askedOf(cluster, order).length)} times, once expected`,
    );
    return survivor(pods, holder);
  },
};

export const s24cZombie: RunnableFaultScenario = {
  id: "s24c-pause-expiry-zombie-refused",
  title:
    "24c: a pod frozen before the compare-and-set of its expiry wakes after another pod expired the pause and finished the order — its record is refused, one decision",
  run: async (cluster) => {
    const pods = await threePods(cluster);
    const [a] = pods;
    if (a === undefined) throw new Error("no pod");
    const order = await pausedOrderOn(cluster, a, "o-24c", FIXTURE_EXPIRING);
    const { holder, held } = await firstToExpire(cluster, pods, order, HoldPhase.Before);
    holder.freeze();
    // another pod's recovery takes the frozen holder's tree over, expires the pause, finishes the order
    const end = await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      end.type === "end" && end.pod !== holder.name,
      `${order.rootExecutionId} was to end on another pod`,
    );
    holder.thaw();
    await release(holder, held);
    // its compare-and-set is answered: refused (the pause is closed already)
    await cluster.next(`the zombie's expiry of ${order.orderId} answered`, () =>
      answered(cluster, StoreHoldPoint.PauseExpire, order.pauseId, holder),
    );
    return survivor(pods, holder);
  },
};

export const s24eOnce: RunnableFaultScenario = {
  id: "s24e-pause-expiry-decided-once",
  title:
    "24e: three pods look for the due pause at the same time — the channel's decision is asked once, one pod expires it, the order is charged and paid once",
  run: async (cluster) => {
    const pods = await threePods(cluster);
    const [a] = pods;
    if (a === undefined) throw new Error("no pod");
    const order = await pausedOrderOn(cluster, a, "o-24e", FIXTURE_EXPIRING);
    await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      askedOf(cluster, order).length === 1,
      `the channel was asked ${String(askedOf(cluster, order).length)} times, once expected`,
    );
    return a;
  },
};
