import { FaultStepPoint } from "../fixture/pod-link.js";
import { FaultPayment } from "../pod-protocol.js";
import type { RunnableFaultScenario } from "../scenario.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * Scenarios 14 and 15 (#657, #658): the gateway's key expires before the call is settled. 14: the
 * gateway charges and its answer is lost — an error of unknown outcome, so the intent stays
 * pending —, the pod is killed in the failed tree's undo and the next pod finishes it; the gateway
 * forgets the key; the order is paid again: the second tree reconciles the first charge by the
 * order's reference, nothing is sent (resent, it would be a new charge). 15: a gateway with no
 * lookup, whose key the call declares kept for less than a takeover takes: the pod is killed with
 * its answer in flight, the gateway forgets the key, and the pod that takes the tree over is told
 * the key's age — its `notSent()` (a replay of the key) is refused, nothing sent, the tree fails
 * for an operator. Each has a sabotage (not in the suite) that charges twice.
 */

/** 14 with `payment`: the default, or the sabotage that takes every error for a definite one. */
async function ambiguousAnswer(cluster: FaultCluster, payment: FaultPayment): Promise<FaultPod> {
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  cluster.gateway.dropAnswer("o-14");
  await holdStep(a, FaultStepPoint.Release, "o-14");
  const failed = await startOrder(cluster, a, "o-14", { fails: true, payment });
  await heldStep(cluster, a, FaultStepPoint.Release, "o-14");
  await a.kill();
  await takenOverBy(cluster, b, failed.rootExecutionId);
  const end = await cluster.ended(failed.rootExecutionId);
  expectThat(
    cluster,
    end.type === "failed" && end.pod === "b",
    `the tree whose answer was lost ${end.type === "failed" ? "failed" : "ended"} on ${end.pod}`,
  );
  cluster.gateway.forgetKeys();
  const again = await startOrder(cluster, b, "o-14", { payment });
  await endedOn(cluster, again.rootExecutionId, b);
  const paid = eventsOf(cluster, "paid").map((event) => `${event.pod}:${String(event.status)}`);
  expectThat(cluster, paid.join() === "b:reconciled", `the payment's outcomes: ${paid.join(", ")}`);
  return b;
}

export const s14AmbiguousAnswer: RunnableFaultScenario = {
  id: "s14-ambiguous-answer-reconciled",
  title:
    "14: the gateway charged and its answer was lost; killed in the undo, the key forgotten, the order paid again — reconciled, one payment",
  run: (cluster) => ambiguousAnswer(cluster, FaultPayment.Lookup),
};

/** 14's sabotage (#657 AC2): every error a definite failure, as before #657 — resent, two payments. */
export const s14EveryErrorDefinite: RunnableFaultScenario = {
  id: "s14-sabotage-every-error-definite",
  title: "14, sabotaged: every gateway error taken for a definite failure",
  run: (cluster) => ambiguousAnswer(cluster, FaultPayment.EveryErrorDefinite),
};

/** 15 with `payment`: the key's retention declared, or the sabotage that declares none. */
async function keyExpired(cluster: FaultCluster, payment: FaultPayment): Promise<FaultPod> {
  const a = await cluster.pod("a");
  const b = await cluster.pod("b");
  cluster.gateway.holdAnswer("o-15");
  const reached = cluster.gateway.answerHeld("o-15");
  const order = await startOrder(cluster, a, "o-15", { fails: true, payment });
  await reached;
  await a.kill();
  cluster.gateway.forgetKeys();
  await takenOverBy(cluster, b, order.rootExecutionId);
  const end = await cluster.ended(order.rootExecutionId);
  expectThat(
    cluster,
    end.type === "failed" && end.pod === "b",
    `the tree whose key expired ${end.type === "failed" ? "failed" : "ended"} on ${end.pod}`,
  );
  const told = eventsOf(cluster, "reconciling").map(
    (event) =>
      `${event.pod}:${String(event.attempt)}:${typeof event.keyAge}:${typeof event.attemptStartedAt}`,
  );
  expectThat(
    cluster,
    told.join() === "b:1:number:string",
    `reconcile was told: ${told.join(", ")}`,
  );
  const failed = eventsOf(cluster, "pay-failed").map(
    (event) => `${event.pod}:${String(event.error)}`,
  );
  expectThat(
    cluster,
    failed.join() === "b:OutboundCallUnreconciledError",
    `the payment failed: ${failed.join(", ")}`,
  );
  return b;
}

export const s15KeyExpired: RunnableFaultScenario = {
  id: "s15-key-expired-not-resent",
  title:
    "15: killed with the answer in flight on a gateway with no lookup, the key expired — the next pod is told its age and sends nothing",
  run: (cluster) => keyExpired(cluster, FaultPayment.ReplayOnly),
};

/**
 * 15's sabotage (#658, #795): the replay trusted as a lookup (`NotSentTrust.Lookup`, no retention) —
 * the replay of an expired key is a new charge, two payments.
 */
export const s15TrustedAsLookup: RunnableFaultScenario = {
  id: "s15-sabotage-replay-trusted-as-lookup",
  title: "15, sabotaged: the gateway's key replay trusted as a lookup",
  run: (cluster) => keyExpired(cluster, FaultPayment.ReplayOnlyTrustedAsLookup),
};
