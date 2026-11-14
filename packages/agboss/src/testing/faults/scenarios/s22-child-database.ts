import { HoldPhase } from "../hold-points.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import { OperationPhase } from "../operation-history.js";
import { ProxyState } from "../database-proxy.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { startBatch } from "./batch-kit.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldAt,
  heldStep,
  holdStep,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenarios 22f and 22g (#928): a claim that is never answered, a database that is frozen.
 * - 22f: pod a's claim of a child is committed in the store and its answer never comes (held for
 *   ever, after the store): a call outside any lease is bounded at 15 s and fails as a store
 *   error; the batch's reclaim takes the path of #720 (a lost answer), the child runs once and
 *   the batch ends;
 * - 22g: the database freezes — the connections stall, or the held stores hang — while a's
 *   charge is about to write: the write and the renewals never answer; a ends within the bound
 *   of its trust, writes nothing and hands over; b takes the tree over at the expiry and charges
 *   once. When the database is back, a's stalled write is fenced.
 */
export const s22fChildClaimNeverAnswered: RunnableFaultScenario = {
  id: "s22f-child-claim-never-answered",
  title:
    "22f: a child's claim answered by the store and never heard — the claim ends at its bound, the child still runs once, the batch ends",
  run: async (cluster) => {
    const a = await cluster.pod("a", { maxConcurrentSteps: 1 });
    await holdStore(a, StoreHoldPoint.ChildClaim, undefined, { phase: HoldPhase.After });
    const batch = await startBatch(cluster, a, ["o-22f"]);
    const held = await heldAt(cluster, a, StoreHoldPoint.ChildClaim);
    await endedOn(cluster, batch.rootExecutionId, a);
    const claims = cluster.history.events.filter(
      (event) =>
        event.phase === OperationPhase.Complete &&
        event.process === "a" &&
        event.operation === StoreHoldPoint.ChildClaim &&
        event.output !== null &&
        event.output !== undefined,
    );
    expectThat(cluster, claims.length >= 2, `a's store answered ${String(claims.length)} claims`);
    await release(a, held);
    return a;
  },
};

export const s22gDatabaseFrozen: RunnableFaultScenario = {
  id: "s22g-database-frozen-mid-charge",
  title:
    "22g: the database freezes as a's charge goes to write — a stops within its bound, writes nothing; the next holder charges once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-22g");
    const order = await startOrder(cluster, a, "o-22g");
    const held = await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-22g");
    await cluster.cutDatabase(a, ProxyState.Frozen);
    await release(a, held);
    await takenOverBy(cluster, b, order.rootExecutionId);
    await endedOn(cluster, order.rootExecutionId, b);
    await cluster.reconnectDatabase(a);
    expectThat(cluster, eventsOf(cluster, "charged", a).length === 0, "a charged while frozen");
    return b;
  },
};
