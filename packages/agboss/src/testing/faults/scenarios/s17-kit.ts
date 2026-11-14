import { A2A_START_LOST } from "../../../a2a/tasks/a2a-task-repair.js";
import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";
import type { FaultCluster } from "../cluster.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultPod } from "../pod.js";
import { StoreHoldPoint } from "../store-points.js";
import { a2aCall, a2aCallInFlight, FaultSkill, orderMessage, type A2AAnswer } from "./a2a-kit.js";
import { eventsOf, expectThat, heldAt, holdStore, release } from "./kit.js";

/** The helpers of scenario 17 and its bounded twins (#811, #1059). */

/** Whether an answer is the task settled start-lost. */
export const isStartLost = (answer: A2AAnswer): boolean =>
  answer.state === A2ATaskState.Failed && answer.code === A2A_START_LOST;

/** The kept answers of the id's keeps by `pod` (`true`: it kept it, `false`: kept before). */
export const keepsOf = (cluster: FaultCluster, pod: FaultPod, taskId: string): readonly unknown[] =>
  cluster.history.events.flatMap((event) =>
    event.phase === OperationPhase.Complete &&
    event.process === pod.name &&
    event.operation === StoreHoldPoint.LeaseClaimExecutionId &&
    event.key === taskId
      ? [(event.output as { kept?: unknown } | undefined)?.kept]
      : [],
  );

/** The frozen accept: a sends the order, held at `point` once the store answered; the task's id. */
export async function frozenAccept(
  cluster: FaultCluster,
  a: FaultPod,
  point: StoreHoldPoint,
  messageId: string,
  orderId: string,
  phase: HoldPhase = HoldPhase.After,
): Promise<{
  readonly taskId: string;
  readonly sent: Promise<A2AAnswer>;
  readonly go: () => Promise<A2AAnswer>;
}> {
  await holdStore(a, point, undefined, { phase });
  // held, its answer may come only after the scenario stopped: a failure then is a note
  const sent = a2aCallInFlight(
    cluster,
    a,
    "SendMessage",
    orderMessage(messageId, orderId, FaultSkill.Order),
  );
  const held = await heldAt(cluster, a, point);
  const taskId = String(held.key);
  return {
    taskId,
    sent,
    go: async () => {
      await release(a, held);
      return sent;
    },
  };
}

/** The task settled `FAILED store.call-timeout`: the start's claim was given up at its bound (#1059). */
export const isCallTimeout = (answer: A2AAnswer): boolean =>
  answer.state === A2ATaskState.Failed && answer.code === "store.call-timeout";

/**
 * After a went on: no step of the task ran anywhere, and every read and a resend say the task is
 * settled (`isSettled`, named `what`: start-lost unless the scenario says otherwise).
 */
export async function settledOnBoth(
  cluster: FaultCluster,
  pods: readonly FaultPod[],
  taskId: string,
  resend: () => Promise<A2AAnswer>,
  settled: { isSettled: (answer: A2AAnswer) => boolean; what: string } = {
    isSettled: isStartLost,
    what: `FAILED ${A2A_START_LOST}`,
  },
): Promise<void> {
  const { isSettled, what } = settled;
  const again = await resend();
  expectThat(
    cluster,
    again.taskId === taskId && isSettled(again),
    `a resend of the message got ${JSON.stringify(again)}, not task ${taskId} ${what}`,
  );
  for (const pod of pods) {
    const read = await a2aCall(cluster, pod, "GetTask", { id: taskId });
    expectThat(cluster, isSettled(read), `${pod.name} read ${JSON.stringify(read)} at the end`);
  }
  const steps = eventsOf(cluster, "step").filter((event) => event.rootExecutionId === taskId);
  expectThat(
    cluster,
    steps.length === 0,
    `the ${what} task ran ${String(steps.length)} steps: ${steps.map((step) => `${String(step.point)} on ${step.pod}`).join(", ")}`,
  );
}

/** Until pod `pod` logged that a call of its own was given up at its bound (`store.call-timeout`). */
export const gaveUp = (cluster: FaultCluster, pod: FaultPod): Promise<unknown> =>
  cluster.until(`${pod.name}'s store.call-timeout`, () =>
    pod.output.includes("store.call-timeout"),
  );
