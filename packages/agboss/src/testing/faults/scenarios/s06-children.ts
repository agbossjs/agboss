import { seconds } from "../../../units/index.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import { FaultInvariant } from "../invariants/violations.js";
import { OperationPhase } from "../operation-history.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { heldChildOn, startBatch } from "./batch-kit.js";
import type { FaultSabotage } from "./sabotages.js";
import { endedOn, expectThat, heldAt, holdStep, holdStore, release, stoppedAt } from "./kit.js";

/**
 * Scenario 6 (#484, #333, #520): scale-down while child workflows are active. A batch of three
 * orders, each a child on any instance, one held on each of three pods; one pod is scaled down
 * (SIGTERM, a short shutdown timeout): its child is interrupted, left running in the queue and
 * reclaimed by a live pod — no child is lost, none runs twice (6). And a pod frozen at its ask for
 * another pod's running child's lease, thawed once that child finished, gets no lease of it: the
 * store refuses finished work in the `acquire` itself (6b, #520 AC1).
 */
export const s06ScaleDown: RunnableFaultScenario = {
  id: "s06-scale-down-children",
  title:
    "6: scale-down while children are active — the stopped pod's child is reclaimed, no child lost or run twice",
  run: async (cluster) => {
    const a = await cluster.pod("a", { maxConcurrentSteps: 1 });
    const b = await cluster.pod("b", { maxConcurrentSteps: 1 });
    const c = await cluster.pod("c", { maxConcurrentSteps: 1, shutdownTimeout: seconds(5) });
    for (const pod of [a, b, c]) await holdStep(pod, FaultStepPoint.ChargeBefore);
    const batch = await startBatch(cluster, a, ["o-6a", "o-6b", "o-6c"]);
    const onC = await heldChildOn(cluster, c);
    await Promise.all([heldChildOn(cluster, a), heldChildOn(cluster, b)]);
    c.terminate();
    await stoppedAt(cluster, c, FaultStepPoint.ChargeBefore, onC.orderId);
    const exit = await c.exited;
    expectThat(
      cluster,
      exit.code === 0,
      `c was to exit by itself; it exited ${JSON.stringify(exit)}`,
    );
    await a.command({ op: "release-all" });
    await b.command({ op: "release-all" });
    await endedOn(cluster, batch.rootExecutionId, a);
    return a;
  },
};

/** What `pod` asked of the lease store for `key` so far, by the id of each ask. */
const asksOf = (cluster: FaultCluster, pod: FaultPod, key: string): readonly string[] =>
  cluster.history.operations
    .filter(
      ({ invoke }) =>
        invoke.process === pod.name &&
        invoke.operation === StoreHoldPoint.LeaseAcquire &&
        invoke.key === key,
    )
    .map(({ invoke }) => invoke.id);

/**
 * 6b's run (#520 AC1, #971): `sabotage` breaks the child's pod's lease store, when given. The held
 * ask is read by its answer — a's one ask before the hold was armed is not it: the hold is before
 * the store is asked, so the held ask's invoke comes after its release, the first ask not seen.
 */
const finishedChildRun =
  (sabotage?: FaultStoreSabotage): RunnableFaultScenario["run"] =>
  async (cluster) => {
    const a = await cluster.pod("a", { maxConcurrentSteps: 1 });
    const b = await cluster.pod("b", { maxConcurrentSteps: 1, sabotage });
    for (const pod of [a, b]) await holdStep(pod, FaultStepPoint.ChargeBefore);
    const batch = await startBatch(cluster, a, ["o-6x", "o-6y"]);
    const [onA, onB] = await Promise.all([heldChildOn(cluster, a), heldChildOn(cluster, b)]);
    await holdStore(a, StoreHoldPoint.LeaseAcquire, onB.executionId);
    // a's own child ends: its one step slot is free, so its worker looks at b's running claim
    await release(a, onA.held);
    const ask = await heldAt(cluster, a, StoreHoldPoint.LeaseAcquire, onB.executionId);
    const before = asksOf(cluster, a, onB.executionId);
    a.freeze();
    await release(b, onB.held);
    await cluster.ended(onB.executionId);
    // the end is announced while the worker still holds the child's lease (#917): wait for the finish
    await cluster.until(`the finish of ${onB.executionId}'s lease`, () =>
      cluster.history.events.some(
        (event) =>
          event.phase === OperationPhase.Complete &&
          event.operation === StoreHoldPoint.LeaseRetire &&
          event.key === onB.executionId,
      ),
    );
    a.thaw();
    await release(a, ask);
    const heldAsk = (): string | undefined =>
      asksOf(cluster, a, onB.executionId).find((id) => !before.includes(id));
    await cluster.until(`the held ask of a for ${onB.executionId}`, () => heldAsk() !== undefined);
    const id = heldAsk();
    const answered = (): boolean =>
      cluster.history.events.some(
        (event) => event.phase === OperationPhase.Complete && event.id === id,
      );
    await cluster.until(`the answer to a's held ask for ${onB.executionId}`, answered);
    const lease = cluster.history.events.find(
      (event) => event.phase === OperationPhase.Complete && event.id === id,
    )?.output;
    expectThat(
      cluster,
      lease === null,
      `a's held ask for the finished child got ${JSON.stringify(lease)}`,
    );
    await cluster.ended(batch.rootExecutionId);
    return b;
  };

export const s06FinishedChild: RunnableFaultScenario = {
  id: "s06b-finished-child-not-taken",
  title:
    "6b: a pod frozen at its ask for another pod's child's lease, thawed after that child finished — it gets no lease, no takeover is written",
  run: finishedChildRun(),
};

/**
 * 6b on a set whose lease store's `retire` is a plain `release` (#971, built from the set's own
 * store): the held ask is granted the finished child's lease. The scenario's own check says so too
 * (a note), and `finished-work-untouched` reads the store's grants.
 */
export const s06cFinishedGranted: FaultSabotage = {
  id: "s06c-sabotage-finished-child-granted",
  title:
    "6c: a finish that is a plain release — the frozen pod's held ask is granted the finished child's lease",
  violates: FaultInvariant.FinishedWorkUntouched,
  evidence: /^the lease of \S+ was granted again \(epoch \d+, to a-\d+\) after it was finished$/u,
  run: finishedChildRun(FaultStoreSabotage.RetireReleases),
};
