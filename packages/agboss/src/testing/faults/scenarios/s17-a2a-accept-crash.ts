import { A2A_START_LOST } from "../../../a2a/tasks/a2a-task-repair.js";
import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";
import type { FaultCluster } from "../cluster.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultPod } from "../pod.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  a2aCall,
  a2aCallInFlight,
  a2aPod,
  FaultSkill,
  orderMessage,
  readUntil,
  type A2AAnswer,
} from "./a2a-kit.js";
import { eventsOf, expectThat, heldAt, holdStore, release } from "./kit.js";

/**
 * Scenario 17 (#811 AC4, design §4.3.2 "Crash between accept and start"): pod a accepts an order
 * sent over A2A and is frozen — held — before its execution's running record: (a) after the task
 * is saved, before its start; (b) after the start kept the task's reserved id. Pod b reads the task
 * past its start timeout and its read repair settles it: (a) its own fence of the id wins — no
 * execution can ever start under it — `FAILED a2a.start-lost`; (b) the fence loses to the frozen
 * starter, so b writes the tree's cancel request, and only one start timeout later settles it
 * `FAILED a2a.start-lost`. Then a goes on: its start is refused (a) or stopped at its first lease
 * take (b) — no step of the order runs, nothing is charged or paid — and the task reads FAILED on
 * both pods, a resend of its message too (`a2a-tasks-once`).
 */

/** Whether an answer is the task settled start-lost. */
const isStartLost = (answer: A2AAnswer): boolean =>
  answer.state === A2ATaskState.Failed && answer.code === A2A_START_LOST;

/** The kept answers of the id's keeps by `pod` (`true`: it kept it, `false`: kept before). */
const keepsOf = (cluster: FaultCluster, pod: FaultPod, taskId: string): readonly unknown[] =>
  cluster.history.events.flatMap((event) =>
    event.phase === OperationPhase.Complete &&
    event.process === pod.name &&
    event.operation === StoreHoldPoint.LeaseClaimExecutionId &&
    event.key === taskId
      ? [(event.output as { kept?: unknown } | undefined)?.kept]
      : [],
  );

/** Whether an answer is the accept the thawed pod's bound gave up on (#928): JSON-RPC -32603. */
const isGivenUp = (answer: A2AAnswer): boolean => answer.errorCode === -32603;

/** The frozen accept: a sends the order, held at `point` once the store answered; the task's id. */
async function frozenAccept(
  cluster: FaultCluster,
  a: FaultPod,
  point: StoreHoldPoint,
  messageId: string,
  orderId: string,
): Promise<{ readonly taskId: string; readonly go: () => Promise<A2AAnswer> }> {
  await holdStore(a, point, undefined, { phase: HoldPhase.After });
  // held, its answer may come only after the scenario stopped: a failure then is a note
  const sent = a2aCallInFlight(
    cluster,
    a,
    "SendMessage",
    orderMessage(messageId, orderId, FaultSkill.Order),
  );
  const held = await heldAt(cluster, a, point);
  const taskId = String(held.key);
  // frozen for real (SIGSTOP, #928): a held call kept longer than the store calls' bound is given up
  // on, so the pod's timers freeze with it — thawed, its overdue bound is what it meets first
  a.freeze();
  return {
    taskId,
    go: async () => {
      a.thaw();
      await release(a, held);
      return sent;
    },
  };
}

/** After a went on: no step of the task ran anywhere, and every read and a resend say start-lost. */
async function settledOnBoth(
  cluster: FaultCluster,
  pods: readonly FaultPod[],
  taskId: string,
  resend: () => Promise<A2AAnswer>,
): Promise<void> {
  const again = await resend();
  expectThat(
    cluster,
    again.taskId === taskId && isStartLost(again),
    `a resend of the message got ${JSON.stringify(again)}, not task ${taskId} FAILED ${A2A_START_LOST}`,
  );
  for (const pod of pods) {
    const read = await a2aCall(cluster, pod, "GetTask", { id: taskId });
    expectThat(cluster, isStartLost(read), `${pod.name} read ${JSON.stringify(read)} at the end`);
  }
  const steps = eventsOf(cluster, "step").filter((event) => event.rootExecutionId === taskId);
  expectThat(
    cluster,
    steps.length === 0,
    `the start-lost task ran ${String(steps.length)} steps: ${steps.map((step) => `${String(step.point)} on ${step.pod}`).join(", ")}`,
  );
}

export const s17AcceptCrash: RunnableFaultScenario = {
  id: "s17-a2a-accept-crash",
  title:
    "17: a pod frozen between an A2A task's accept and its start — another pod's read fences the id, FAILED start-lost, nothing runs",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17", "o-17", FaultSkill.Order);
    const { taskId, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.A2ATaskSaveIfAbsent,
      "m-17",
      "o-17",
    );
    await readUntil(cluster, b, taskId, `FAILED ${A2A_START_LOST}`, isStartLost);
    expectThat(
      cluster,
      keepsOf(cluster, b, taskId).includes(true),
      `b's fence of ${taskId} did not keep the id: ${JSON.stringify(keepsOf(cluster, b, taskId))}`,
    );
    // a's own answer, released after b settled the task: the task as it is now, never as saved
    const thawed = await go();
    // thawed, a's overdue bound (#928) gives the held accept up: nothing started under the task's
    // id; a store that answered in time would have met b's fence and read the task start-lost
    expectThat(
      cluster,
      isGivenUp(thawed) || (thawed.taskId === taskId && isStartLost(thawed)),
      `a's held accept answered ${JSON.stringify(thawed)}, not -32603 nor task ${taskId} FAILED ${A2A_START_LOST}`,
    );
    await settledOnBoth(cluster, [a, b], taskId, () => a2aCall(cluster, b, "SendMessage", message));
    return b;
  },
};

export const s17bIdKeptCrash: RunnableFaultScenario = {
  id: "s17b-a2a-id-kept-crash",
  title:
    "17b: a pod frozen between keeping an A2A task's id and its running record — the read cancels its tree, FAILED start-lost a start timeout later, the thawed start runs nothing",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17b", "o-17b", FaultSkill.Order);
    const { taskId, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.LeaseClaimExecutionId,
      "m-17b",
      "o-17b",
    );
    await readUntil(cluster, b, taskId, `FAILED ${A2A_START_LOST}`, isStartLost);
    const requested = cluster.history.events.filter(
      (event) =>
        event.phase === OperationPhase.Complete &&
        event.process === b.name &&
        event.operation === StoreHoldPoint.A2ATaskStatusWrite &&
        event.key === taskId &&
        (event.output as { cancelRequested?: unknown } | null)?.cancelRequested === true,
    );
    expectThat(
      cluster,
      keepsOf(cluster, b, taskId).includes(false) && requested.length === 1,
      `b's fence was to lose to a's kept id and write the cancel request once: keeps ${JSON.stringify(keepsOf(cluster, b, taskId))}, ${String(requested.length)} requests`,
    );
    // the accept answered before the start froze — SUBMITTED, before b's read settled the task;
    // only the detached start was held
    const early = eventsOf(cluster, "a2a-answer", a).find(
      (event) => event.method === "SendMessage",
    );
    expectThat(
      cluster,
      early?.taskId === taskId && early.state === A2ATaskState.Submitted,
      `a's accept was to answer task ${taskId} SUBMITTED before its start froze: ${JSON.stringify(early)}`,
    );
    const answered = await go();
    expectThat(
      cluster,
      answered.taskId === taskId && answered.state === A2ATaskState.Submitted,
      `a's accept answered ${JSON.stringify(answered)}`,
    );
    // a's start, thawed past its bound (#928), gives up its claim of the id: no tree starts and no
    // step runs — where an answered claim would have been stopped by the tree's cancel request
    await settledOnBoth(cluster, [a, b], taskId, () => a2aCall(cluster, a, "SendMessage", message));
    return b;
  },
};
