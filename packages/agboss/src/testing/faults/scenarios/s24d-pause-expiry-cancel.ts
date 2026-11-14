import { HoldPhase } from "../hold-points.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { answered, FIXTURE_EXPIRING, firstToExpire, survivor, threePods } from "./expiry-kit.js";
import { eventsOf, expectThat, release } from "./kit.js";
import { pausedOrderOn } from "./pause-kit.js";

/**
 * Scenario 24d (#941, #910 I3): a cancel requested while the holder of an expiry waits to record it —
 * the order ends cancelled, nothing is charged or paid after the cancel (`no-effect-after-cancel`).
 */

export const s24dCancel: RunnableFaultScenario = {
  id: "s24d-pause-expiry-cancel",
  title:
    "24d: a cancel requested while the holder of the expiry waits to record it — the order ends cancelled, nothing is charged or paid after the cancel",
  run: async (cluster) => {
    const pods = await threePods(cluster);
    const [a] = pods;
    if (a === undefined) throw new Error("no pod");
    const order = await pausedOrderOn(cluster, a, "o-24d", FIXTURE_EXPIRING, {
      cancelled: true,
    });
    const { holder, held } = await firstToExpire(cluster, pods, order, HoldPhase.Before);
    const canceller = survivor(pods, holder);
    await canceller.command({ op: "cancel", tag: "cancel-24d", threadId: "thread-o-24d" });
    // the cancel is durable (its mark answered) before the holder records the expiry
    await cluster.next("the cancel's mark of the tree answered", () =>
      answered(cluster, StoreHoldPoint.LeaseRequestCancel, order.rootExecutionId),
    );
    await release(holder, held);
    const end = await cluster.ended(order.rootExecutionId);
    expectThat(
      cluster,
      end.type !== "end",
      `${order.rootExecutionId} was to end cancelled, it finished`,
    );
    expectThat(
      cluster,
      eventsOf(cluster, "step").every(
        (event) => event.orderId !== order.orderId || event.point !== "charge.after",
      ),
      `${order.orderId} was charged after its cancel`,
    );
    return canceller;
  },
};
