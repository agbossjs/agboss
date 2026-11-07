import { LeaseTakeoverReason } from "../../../infrastructure/execution-lease-event.repository.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { startBatch } from "./batch-kit.js";
import { endedOn, eventsOf, expectThat, holdStore } from "./kit.js";

/**
 * Scenario 16 (#720): the answers of a pod's child claims are lost — the store claimed the child
 * for the pod (`Running`, its instance) and the pod never heard (a connection that drops after the
 * commit; on PostgreSQL #720's claim that marked several rows and returned one). The pod hosts the
 * batch: its parent's watch sees the child `Running` with a free lease and its worker reclaims it,
 * queues it again and keeps the lease for its next claim — whose answer is lost too. Before #720 the
 * kept lease was renewed for ever with no pass behind it: the child was never run and the batch
 * never ended. Now the lease goes back when the reclaim's look did not start the child, and the
 * next reclaim and claim run it — once.
 */
export const s16ClaimAnswerLost: RunnableFaultScenario = {
  id: "s16-claim-answer-lost",
  title:
    "16: a pod's claims of a child answered but never heard, twice — the child still runs once, the batch ends",
  run: async (cluster) => {
    const a = await cluster.pod("a", { maxConcurrentSteps: 1 });
    const lost = { phase: HoldPhase.After, times: 2, loseAnswer: true } as const;
    await holdStore(a, StoreHoldPoint.ChildClaim, undefined, lost);
    const batch = await startBatch(cluster, a, ["o-16"]);
    await endedOn(cluster, batch.rootExecutionId, a);
    const claims = cluster.history.events.filter(
      (event) =>
        event.phase === OperationPhase.Complete &&
        event.process === "a" &&
        event.operation === StoreHoldPoint.ChildClaim &&
        event.output !== null &&
        event.output !== undefined,
    );
    expectThat(
      cluster,
      claims.length >= 3,
      `a's store answered ${String(claims.length)} claims of the child: two lost, then the one that ran it`,
    );
    const reclaims = eventsOf(cluster, "takeover", a).filter(
      (event) => event.reason === LeaseTakeoverReason.RemoteChild,
    );
    expectThat(
      cluster,
      reclaims.length >= 2,
      `a reclaimed the child ${String(reclaims.length)} times: once per lost claim`,
    );
    return a;
  },
};
