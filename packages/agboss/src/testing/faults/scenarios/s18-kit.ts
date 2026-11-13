import { EXECUTION_LEASE } from "../../../app/lease-fence.js";
import {
  A2ATaskState,
  isTerminalA2ATaskState,
} from "../../../infrastructure/a2a-task.repository.js";
import { seconds } from "../../../units/index.js";
import type { FaultCluster } from "../cluster.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultPod } from "../pod.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  a2aCall,
  a2aCallInFlight,
  a2aPod,
  approval,
  FaultSkill,
  orderMessage,
  readUntil,
  type A2AAnswer,
} from "./a2a-kit.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import { eventsOf, expectThat, heldAt, holdStore, release } from "./kit.js";
import { pauseStateOn } from "./pause-kit.js";

/**
 * What scenario 18 (#811 AC4) is written with: a task resting at its order's approval, the race of
 * a follow-up's resume on pod a with a `CancelTask` on pod b, and what each end must show.
 */

/** Whether an answer is the task canceled. */
export const isCanceled = (answer: A2AAnswer): boolean => answer.state === A2ATaskState.Canceled;

/** What `pod`'s store answered to its transitions of a pause at `point` (`true`: it moved it). */
export const movedBy = (
  cluster: FaultCluster,
  pod: FaultPod,
  point: StoreHoldPoint,
): readonly unknown[] =>
  cluster.history.events.flatMap((event) =>
    event.phase === OperationPhase.Complete &&
    event.process === pod.name &&
    event.operation === point
      ? [(event.output as { isChanged?: unknown } | undefined)?.isChanged]
      : [],
  );

/** A task of an approved order, accepted on `a`, resting at its approval. */
export async function pausedTask(
  cluster: FaultCluster,
  a: FaultPod,
  orderId: string,
): Promise<string> {
  const accepted = await a2aCall(
    cluster,
    a,
    "SendMessage",
    orderMessage(`m-${orderId}`, orderId, FaultSkill.Approval),
  );
  const taskId = accepted.taskId ?? "";
  expectThat(
    cluster,
    taskId !== "",
    `the order's message got no task: ${JSON.stringify(accepted)}`,
  );
  await readUntil(
    cluster,
    a,
    taskId,
    "INPUT_REQUIRED",
    (answer) => answer.state === A2ATaskState.InputRequired,
  );
  return taskId;
}

/** The race set up: a's follow-up held at `point` (`phase`), the task and the follow-up. */
export async function raced(
  cluster: FaultCluster,
  orderId: string,
  point: StoreHoldPoint,
  phase: HoldPhase,
): Promise<{
  readonly a: FaultPod;
  readonly b: FaultPod;
  readonly taskId: string;
  readonly resumed: () => Promise<A2AAnswer>;
}> {
  const a = await a2aPod(cluster, "a");
  const b = await a2aPod(cluster, "b");
  const taskId = await pausedTask(cluster, a, orderId);
  await holdStore(a, point, undefined, { phase });
  const resume = a2aCallInFlight(cluster, a, "SendMessage", approval(`m-${orderId}-yes`, taskId));
  const held = await heldAt(cluster, a, point);
  return {
    a,
    b,
    taskId,
    resumed: async () => {
      await release(a, held);
      return resume;
    },
  };
}

/** At the end: canceled on both pods, nothing charged or paid, the reservation undone once. */
export async function canceledOnBoth(
  cluster: FaultCluster,
  pods: readonly FaultPod[],
  taskId: string,
): Promise<void> {
  for (const pod of pods) await readUntil(cluster, pod, taskId, "CANCELED", isCanceled);
  const tree = (type: string) =>
    eventsOf(cluster, type).filter((event) => event.rootExecutionId === taskId);
  const paid = tree("step").filter((step) => step.point === FaultStepPoint.PayBefore);
  expectThat(
    cluster,
    paid.length === 0 && tree("charged").length === 0 && cluster.gateway.requests.length === 0,
    `the canceled task was charged (${String(tree("charged").length)}) or paid (${String(paid.length)} steps, ${String(cluster.gateway.requests.length)} gateway requests)`,
  );
  const released = tree("released");
  expectThat(
    cluster,
    released.length === 1,
    `the canceled task's reservation was released ${String(released.length)} times, not once`,
  );
}

/** What each pod's store said to its transitions of the pause, for a failed expectation. */
export const transitionsOf = (cluster: FaultCluster, a: FaultPod, b: FaultPod): string =>
  `a's resolve ${JSON.stringify(movedBy(cluster, a, StoreHoldPoint.PauseResolve))}, b's cancel ${JSON.stringify(movedBy(cluster, b, StoreHoldPoint.PauseCancel))}`;

/** Whether the resume took the pause and the cancel found it taken. */
export const isResumedFirst = (cluster: FaultCluster, a: FaultPod, b: FaultPod): boolean =>
  movedBy(cluster, a, StoreHoldPoint.PauseResolve).includes(true) &&
  !movedBy(cluster, b, StoreHoldPoint.PauseCancel).includes(true);

/** A cancel the server took: a task in a state, canceled or still moving, never an error. */
export const isAccepted = (cancel: A2AAnswer): boolean =>
  cancel.errorCode === undefined &&
  cancel.state !== undefined &&
  (cancel.state === A2ATaskState.Canceled || !isTerminalA2ATaskState(cancel.state));

/**
 * Whether a's held charge of `orderId` stopped within two leases of the pods' clock: its holder
 * reads the cancel request at its next renewal, well inside one lease.
 */
export async function isStoppedWithin(
  cluster: FaultCluster,
  a: FaultPod,
  orderId: string,
): Promise<boolean> {
  const bound = seconds((2 * EXECUTION_LEASE) / 1000 / cluster.options.timeScale);
  const stopped = await cluster
    .next(
      `charge.before of ${orderId} stopped on a`,
      (event) =>
        event.type === "step-stopped" &&
        event.pod === a.name &&
        event.point === FaultStepPoint.ChargeBefore &&
        event.orderId === orderId,
      bound,
    )
    .then(
      () => true,
      () => false,
    );
  expectThat(
    cluster,
    stopped,
    `a's pass was not stopped within two leases of the cancel: its charge was let go`,
  );
  return stopped;
}

/**
 * After a pod died holding a tree's end (#939): the resume that finished it was refused `-32004
 * a2a.pause-closed`, `cancelled`, and the tree left no `Resolved` pause and no paused run — its
 * answer logged not taken.
 */
export async function expectEndFinished(
  cluster: FaultCluster,
  resumed: A2AAnswer,
  pod: FaultPod,
  taskId: string,
): Promise<void> {
  expectThat(
    cluster,
    resumed.errorCode === -32004 &&
      resumed.errorMetadata?.code === "a2a.pause-closed" &&
      resumed.errorMetadata.reason === "cancelled",
    `the resume of the ended tree was to be -32004 a2a.pause-closed, cancelled: ${JSON.stringify(resumed)}`,
  );
  const state = await pauseStateOn(pod, taskId);
  const open = state.pauses.filter((p) => p.status === "pending" || p.status === "resolved");
  const notTaken = state.log.filter((entry) => !entry.isTaken && entry.resolution === "cancelled");
  expectThat(
    cluster,
    open.length === 0 && !state.hasPausedRun && notTaken.length === 1,
    `s18d: pauses open ${String(open.length)}, paused run ${state.hasPausedRun ? "kept" : "none"}, log not-taken ${String(notTaken.length)}: ${JSON.stringify(state)}`,
  );
}
