import { HoldPhase } from "../hold-points.js";
import { commitBytesOf, tcpTargetOf } from "../cluster-options.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import { FaultScenarioSkippedError, type RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, holdStore, startOrder, takenOverBy } from "./kit.js";
import { chargesOf, statusesOf } from "./s22-kit.js";

/**
 * Scenario 23 (#1017): the charge's COMMIT is applied and its answer is lost — the connection is
 * reset right after (`DatabaseProxy.dropAfter`) on a database reached over TCP, or the held store's
 * answer is lost as a transport error where there is no network. The store reads it as an error of
 * unknown outcome (its classifier), so pod a hands the tree over: no `.onError`, no undo, no failed
 * record. Pod b takes it over at the lease's expiry and replays the row — one charge.
 *
 * A store whose client retries a commit and learns its real outcome (`FaultStoreSet.
 * resolvesCommitByRetry`: MongoDB's idempotent `commitTransaction`) has no unknown outcome after
 * one reset: scenario 23 then asks that the charge lands once, on pod a, with no hand-over. Its
 * truly unknown commit — the reset persisting across the retry — is scenario 23b.
 */

/**
 * Pod a's charge write, applied and its answer lost: through its proxy when it has one, else in
 * the held store. `times` cuts of the COMMIT's answer (a retry's too, when more than one).
 */
export async function resetAfterCharge(
  cluster: FaultCluster,
  a: FaultPod,
  times = 1,
): Promise<void> {
  const proxy = cluster.proxyOf(a.name);
  const commit = commitBytesOf(cluster.options.database.url);
  if (proxy !== undefined && commit !== undefined && tcpTargetOf(cluster.options.database.url)) {
    // the charge's row text (`charge:<execution>`) then the bytes that apply it, on one link; a
    // retry of the commit is on another link: only its bytes match
    proxy.dropAfterRepeated(times, "charge:", commit);
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

/**
 * Pod a (`started`, else made with `sabotage`, when given) starts `orderId`; its charge's answer is lost `times` times.
 * Pod a's own takes of the tree are held, so that b's is the one that takes the expired lease.
 */
export async function lostChargeAnswer(
  cluster: FaultCluster,
  orderId: string,
  sabotage?: FaultStoreSabotage,
  times = 1,
  started?: FaultPod,
): Promise<LostCharge> {
  const a =
    started ??
    (await cluster.pod("a", {
      isBounded: true,
      ...(sabotage === undefined ? {} : { sabotage }),
    }));
  const b = await cluster.pod("b", { isBounded: true });
  await resetAfterCharge(cluster, a, times);
  const order = await startOrder(cluster, a, orderId);
  const key = order.rootExecutionId;
  // a's own sweep must not take the expired tree back before b's: its takes of it are held (as in 22)
  await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
  return { a, b, key };
}

/** The proxy of pod `a` cut as many links as the scenario armed: its fault was delivered, never assumed. */
export function expectCuts(cluster: FaultCluster, a: FaultPod, cuts: number): void {
  const proxy = cluster.proxyOf(a.name);
  if (proxy === undefined) return;
  expectThat(
    cluster,
    proxy.cutsAfterWrite >= cuts,
    `the COMMIT's answer was to be cut ${String(cuts)} time(s); the proxy cut ${String(proxy.cutsAfterWrite)}`,
  );
}

/** Pod a handed the tree over, b replayed the row: one charge, none heard by a. */
export async function handedOverAndReplayed(
  cluster: FaultCluster,
  orderId: string,
  { a, b, key }: LostCharge,
): Promise<void> {
  await cluster.next(
    `a's hand-over of ${key}`,
    (event) => event.type === "handed-over" && event.pod === a.name,
  );
  await takenOverBy(cluster, b, key);
  await endedOn(cluster, key, b);
  const statuses = statusesOf(cluster, "charged", b);
  expectThat(cluster, statuses === "replayed", `b's charge was to be replayed; it was ${statuses}`);
  expectThat(cluster, eventsOf(cluster, "charged", a).length === 0, "a heard its charge answered");
  expectThat(
    cluster,
    chargesOf(cluster, orderId) === "b",
    `the gateway's charges of ${orderId} came from ${chargesOf(cluster, orderId)}, not b only`,
  );
  expectThat(
    cluster,
    a.output.includes("store.outcome-unknown"),
    "a's log has no store.outcome-unknown: its call was not read as unknown by the store",
  );
}

/** A reset the commit's retry answers needs a link to cut: a set without a network skips (#1017). */
export function needsLink(cluster: FaultCluster, a: FaultPod): void {
  if (cluster.proxyOf(a.name) === undefined)
    throw new FaultScenarioSkippedError(
      "the store set declares a retried commit but has no TCP link to cut: its lost answer cannot be simulated",
    );
}

/** One reset, answered by the commit's retry: the charge lands once, on a, no hand-over. */
async function resolvedByRetry(cluster: FaultCluster, a: FaultPod): Promise<FaultPod> {
  needsLink(cluster, a);
  await cluster.pod("b", { isBounded: true });
  await resetAfterCharge(cluster, a);
  const order = await startOrder(cluster, a, "o-23");
  await endedOn(cluster, order.rootExecutionId, a);
  expectCuts(cluster, a, 1);
  expectThat(
    cluster,
    eventsOf(cluster, "handed-over", a).length === 0,
    "a handed the tree over: its commit's retry was to learn the outcome",
  );
  expectThat(
    cluster,
    eventsOf(cluster, "charged", a).length === 1,
    "a was to hear its charge answered once",
  );
  expectThat(
    cluster,
    chargesOf(cluster, "o-23") === "a",
    `the gateway's charges of o-23 came from ${chargesOf(cluster, "o-23")}, not a only`,
  );
  expectThat(
    cluster,
    !a.output.includes("store.outcome-unknown"),
    "a's log has store.outcome-unknown: the retry resolved the commit, nothing was unknown",
  );
  return a;
}

export const s23CommitAnswerReset: RunnableFaultScenario = {
  id: "s23-commit-answer-reset",
  title:
    "23: the charge's COMMIT applied and its connection reset — the store reads it as unknown: a hands over (no undo), b replays the row, one charge",
  run: async (cluster) => {
    const a = await cluster.pod("a", { isBounded: true });
    if (a.resolvesCommitByRetry) return resolvedByRetry(cluster, a);
    const lost = await lostChargeAnswer(cluster, "o-23", undefined, 1, a);
    await handedOverAndReplayed(cluster, "o-23", lost);
    return lost.b;
  },
};

export const s23bCommitAnswerResetPersists: RunnableFaultScenario = {
  id: "s23b-commit-answer-reset-persists",
  title:
    "23b: the charge's COMMIT applied and the answer of its retry lost too — the outcome stays unknown: a hands over (no undo), b replays the row, one charge",
  run: async (cluster) => {
    const a = await cluster.pod("a", { isBounded: true });
    if (!a.resolvesCommitByRetry)
      throw new FaultScenarioSkippedError(
        "the store set's commit is not retried: scenario 23 cuts its one answer",
      );
    needsLink(cluster, a);
    const lost = await lostChargeAnswer(cluster, "o-23b", undefined, 2, a);
    await handedOverAndReplayed(cluster, "o-23b", lost);
    expectCuts(cluster, lost.a, 2);
    return lost.b;
  },
};
