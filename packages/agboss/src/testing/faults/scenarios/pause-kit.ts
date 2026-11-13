import { ExecutionStatus } from "../../../app/types.js";
import type { FaultCluster } from "../cluster.js";
import type { PodEventFact } from "../facts.js";
import type { FaultPod } from "../pod.js";
import { FaultWorkflow } from "../pod-protocol.js";
import { FaultPauseStateSchema, type FaultPauseState } from "../pod-pause-state.js";
import { expectThat } from "./kit.js";

/**
 * What the pause scenarios (#959) are written with: an order started on a pod that rests at its
 * question, the pause's id read from the rest, and `app.resume` of that id on a pod, in the
 * background. Self-contained — the pause hold points of #939 build on these.
 */

/** An order resting at its pause: its root tree and the pause to answer. */
export interface PausedOrder {
  readonly orderId: string;
  readonly rootExecutionId: string;
  readonly pauseId: string;
}

/** Starts a paused order on `pod` and resolves once its tree rests at its pause. */
export async function pausedOrderOn(
  cluster: FaultCluster,
  pod: FaultPod,
  orderId: string,
): Promise<PausedOrder> {
  const tag = await cluster.start(pod, FaultWorkflow.Pause, [{ orderId }]);
  const reserved = await cluster.stepOf(orderId, "reserve");
  const rested = await cluster.next(
    `${orderId} resting at its pause`,
    (event) => event.type === "finished" && event.tag === tag,
  );
  const pauseIds = Array.isArray(rested.pauseIds) ? rested.pauseIds.map(String) : [];
  expectThat(
    cluster,
    rested.status === ExecutionStatus.Paused && pauseIds.length === 1,
    `${orderId} was to rest at one pause, it came to ${JSON.stringify({ status: rested.status, pauseIds })}`,
  );
  return {
    orderId,
    rootExecutionId: String(reserved.rootExecutionId),
    pauseId: pauseIds[0] ?? "",
  };
}

/** `app.resume` of `pauseId` on `pod`, in the background: its tag, and its end as an event. */
export async function answerOn(pod: FaultPod, pauseId: string): Promise<string> {
  const tag = `${pod.name}:resume:${pauseId}`;
  await pod.command({ op: "resume", tag, pauseId });
  return tag;
}

/** The end of the resume `tag`: it finished the tree, on whichever pod. */
export async function resumeFinished(cluster: FaultCluster, tag: string): Promise<PodEventFact> {
  return cluster.next(
    `the resume ${tag} finished`,
    (event) => event.type === "finished" && event.tag === tag,
  );
}

/** The tree's pauses, paused run and answer log, read on `pod` (#939). */
export async function pauseStateOn(
  pod: FaultPod,
  rootExecutionId: string,
): Promise<FaultPauseState> {
  return FaultPauseStateSchema.parse(await pod.command({ op: "pause-state", rootExecutionId }));
}
