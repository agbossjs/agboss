import { HoldPhase } from "../hold-points.js";
import { commitBytesOf, tcpTargetOf } from "../cluster-options.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, holdStore, startOrder, takenOverBy } from "./kit.js";
import { chargesOf, statusesOf } from "./s22-kit.js";

/**
 * Scenario 23 (#1017): the charge's COMMIT is applied and its answer is lost — the connection is
 * reset right after (`DatabaseProxy.dropAfter`) on a database reached over TCP, or the held store's
 * answer is lost as a transport error where there is no network. The store reads it as an error of
 * unknown outcome (its classifier), so pod a hands the tree over: no `.onError`, no undo, no failed
 * record. Pod b takes it over at the lease's expiry and replays the row — one charge.
 */

/** Pod a's charge write, applied and its answer lost: through its proxy when it has one, else in the held store. */
export async function resetAfterCharge(cluster: FaultCluster, a: FaultPod): Promise<void> {
  const proxy = cluster.proxyOf(a.name);
  const commit = commitBytesOf(cluster.options.database.url);
  if (proxy !== undefined && commit !== undefined && tcpTargetOf(cluster.options.database.url)) {
    // the charge's row text (`charge:<execution>`) then the bytes that apply it, on one link
    proxy.dropAfter("charge:", commit);
    return;
  }
  await holdStore(a, StoreHoldPoint.FencedEffectWrite, undefined, {
    ...{ phase: HoldPhase.After, loseAnswer: true, asTransportError: true },
  });
}

/** The two pods and the tree of an order whose charge's answer is lost. */
export interface LostCharge {
  readonly a: FaultPod;
  readonly b: FaultPod;
  readonly key: string;
}

/** Pod a (with `sabotage`, when given) starts `orderId`; its charge's answer is lost. */
export async function lostChargeAnswer(
  cluster: FaultCluster,
  orderId: string,
  sabotage?: FaultStoreSabotage,
): Promise<LostCharge> {
  const a = await cluster.pod("a", {
    isBounded: true,
    ...(sabotage === undefined ? {} : { sabotage }),
  });
  const b = await cluster.pod("b", { isBounded: true });
  await resetAfterCharge(cluster, a);
  const order = await startOrder(cluster, a, orderId);
  const key = order.rootExecutionId;
  // a's own sweep must not take the expired tree back before b's: its takes of it are held (as in 22)
  await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
  return { a, b, key };
}

export const s23CommitAnswerReset: RunnableFaultScenario = {
  id: "s23-commit-answer-reset",
  title:
    "23: the charge's COMMIT applied and its connection reset — the store reads it as unknown: a hands over (no undo), b replays the row, one charge",
  run: async (cluster) => {
    const { a, b, key } = await lostChargeAnswer(cluster, "o-23");
    await cluster.next(
      `a's hand-over of ${key}`,
      (event) => event.type === "handed-over" && event.pod === a.name,
    );
    await takenOverBy(cluster, b, key);
    await endedOn(cluster, key, b);
    const statuses = statusesOf(cluster, "charged", b);
    expectThat(
      cluster,
      statuses === "replayed",
      `b's charge was to be replayed; it was ${statuses}`,
    );
    expectThat(
      cluster,
      eventsOf(cluster, "charged", a).length === 0,
      "a heard its charge answered",
    );
    expectThat(
      cluster,
      chargesOf(cluster, "o-23") === "b",
      `the gateway's charges of o-23 came from ${chargesOf(cluster, "o-23")}, not b only`,
    );
    expectThat(
      cluster,
      a.output.includes("store.outcome-unknown"),
      "a's log has no store.outcome-unknown: its call was not read as unknown by the store",
    );
    return b;
  },
};
