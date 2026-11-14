import { pauseKeyOf } from "../../../infrastructure/pause-record.js";
import type { FaultCluster } from "../cluster.js";
import type { PodEventFact } from "../facts.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultPod } from "../pod.js";
import { FaultWorkflow } from "../pod-protocol.js";
import { StoreHoldPoint } from "../store-points.js";
import { eventsOf, holdStore } from "./kit.js";
import type { PausedOrder } from "./pause-kit.js";

/** What the expiry scenarios (#941, s24) are written with: three pods and the first to expire. */

export const FIXTURE_EXPIRING = FaultWorkflow.Expiring;

/** The expiry asked of the channel, in the order the test heard them. */
export const askedOf = (cluster: FaultCluster, order: PausedOrder): readonly PodEventFact[] =>
  eventsOf(cluster, "pause-expiry-asked").filter(
    (event) => event.pauseKey === pauseKeyOf("default", order.pauseId),
  );

/** Every pod holds the first expiry it reaches; resolves with the pod that did and its held event. */
export async function firstToExpire(
  cluster: FaultCluster,
  pods: readonly FaultPod[],
  order: PausedOrder,
  phase: HoldPhase,
): Promise<{ readonly holder: FaultPod; readonly held: PodEventFact }> {
  for (const pod of pods)
    await holdStore(pod, StoreHoldPoint.PauseExpire, order.pauseId, { phase });
  const held = await cluster.next(
    `the first expiry of ${order.orderId}'s pause held`,
    (event) =>
      event.type === "held" &&
      event.point === StoreHoldPoint.PauseExpire &&
      event.key === order.pauseId,
  );
  const holder = pods.find((pod) => pod.name === held.pod);
  if (holder === undefined) throw new Error(`pod ${held.pod} is no pod of this scenario`);
  // the other pods are armed no more: one tree is expired by one pod at a time (the lease)
  for (const pod of pods) if (pod !== holder) await pod.command({ op: "release-all" });
  return { holder, held };
}

/** Whether a store operation of `key` was answered without an error: by `pod` when given. */
export const answered = (
  cluster: FaultCluster,
  operation: StoreHoldPoint,
  key: string,
  pod?: FaultPod,
): boolean =>
  cluster.history.events.some(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.operation === operation &&
      event.key === key &&
      (pod === undefined || event.process === pod.name),
  );

/** The pods of a scenario: three, `a` starts the order. */
export async function threePods(cluster: FaultCluster): Promise<readonly FaultPod[]> {
  return [await cluster.pod("a"), await cluster.pod("b"), await cluster.pod("c")];
}

/** The pod that reads the end: any pod still running. */
export const survivor = (pods: readonly FaultPod[], dead: FaultPod): FaultPod => {
  const found = pods.find((pod) => pod !== dead && pod.isRunning);
  if (found === undefined) throw new Error("no pod left to finish the order");
  return found;
};
