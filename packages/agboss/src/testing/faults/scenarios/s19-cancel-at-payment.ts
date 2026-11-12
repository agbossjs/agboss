import { OperationPhase } from "../operation-history.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  a2aCall,
  a2aCallInFlight,
  a2aPod,
  FaultSkill,
  orderMessage,
  readUntil,
} from "./a2a-kit.js";
import { eventsOf, expectThat, heldAt, holdStore, release } from "./kit.js";
import { isAccepted, isCanceled } from "./s18-kit.js";

/**
 * Scenario 19 (#909, design §4.3.2 "cancel is a fence"): a live holder between its tree's cancel
 * request and its next lease renewal — a window of up to a lease, which the holder never reads —
 * reaches a fenced write. Pod a runs an order's task and is held at the write, before the store is
 * asked; a `CancelTask` on pod b answers once the tree's mark (`lease.requestCancel`) is durable;
 * then a's write goes on. The store refuses it in the lease's transaction (no renewal needed): the
 * step stops, the tree unwinds as cancelled, its reservation undone once, `CANCELED`:
 * - 19, at the charge's fenced write (`fencedEffect.write`): nothing is charged or paid;
 * - 19b, at the payment's intent (`outboundCall.saveIfAbsent`, after the charge committed — before
 *   the cancel, so it stands): no intent is recorded, the gateway got no request.
 * No effect is committed after the mark's answer (`no-effect-after-cancel`, `a2a-tasks-once`).
 */

/** A task of an order accepted on `a`, held at its write `point`; the held operation's key. */
async function heldTask(
  cluster: FaultCluster,
  a: FaultPod,
  orderId: string,
  point: StoreHoldPoint,
): Promise<{ readonly taskId: string; readonly held: Awaited<ReturnType<typeof heldAt>> }> {
  await holdStore(a, point, undefined);
  const accepted = a2aCallInFlight(
    cluster,
    a,
    "SendMessage",
    orderMessage(`m-${orderId}`, orderId, FaultSkill.Order),
  );
  const taskId = (await accepted).taskId ?? "";
  expectThat(cluster, taskId !== "", `the order's message got no task`);
  return { taskId, held: await heldAt(cluster, a, point, taskId) };
}

/** Whether pod `pod`'s `requestCancel` of `taskId` was answered. */
const markAnswered = (cluster: FaultCluster, taskId: string): boolean =>
  cluster.history.events.some(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.operation === StoreHoldPoint.LeaseRequestCancel &&
      event.key === taskId &&
      event.error === undefined,
  );

/** How pod `pod`'s held write `point` of `taskId` ended, from the history. */
function writeEnd(cluster: FaultCluster, pod: FaultPod, taskId: string, point: StoreHoldPoint) {
  return cluster.history.events.find(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.process === pod.name &&
      event.operation === point &&
      event.key === taskId,
  );
}

/** The cancel after the hold, the write let go, and what must be true at the end. */
async function cancelledAt(
  cluster: FaultCluster,
  point: StoreHoldPoint,
  orderId: string,
): Promise<FaultPod> {
  const a = await a2aPod(cluster, "a");
  const b = await a2aPod(cluster, "b");
  const { taskId, held } = await heldTask(cluster, a, orderId, point);
  // no renewal of a's lease is awaited: the cancel lands in the window
  const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
  expectThat(cluster, isAccepted(cancel), `the cancel was refused: ${JSON.stringify(cancel)}`);
  expectThat(
    cluster,
    markAnswered(cluster, taskId),
    "the cancel answered before its mark was durable",
  );
  await release(a, held);
  await cluster.ended(taskId);
  await readUntil(cluster, b, taskId, "CANCELED", isCanceled);
  const refused = writeEnd(cluster, a, taskId, point)?.error?.name;
  expectThat(
    cluster,
    refused === "ExecutionCancelFencedError",
    `a's write after the cancel was to be refused (ExecutionCancelFencedError); it was ${refused ?? "accepted"}`,
  );
  const tree = (type: string) =>
    eventsOf(cluster, type).filter((event) => event.rootExecutionId === taskId);
  expectThat(
    cluster,
    tree("released").length === 1,
    `the canceled task's reservation was released ${String(tree("released").length)} times, not once`,
  );
  expectThat(
    cluster,
    cluster.gateway.requests.length === 0,
    `the gateway got ${String(cluster.gateway.requests.length)} requests after the cancel`,
  );
  return b;
}

export const s19CancelAtCharge: RunnableFaultScenario = {
  id: "s19-cancel-at-charge",
  title:
    "19: a live holder between its task's cancel request and its next renewal reaches the charge's fenced write — refused, nothing charged or paid, the reservation undone once, CANCELED",
  run: async (cluster) => {
    const b = await cancelledAt(cluster, StoreHoldPoint.FencedEffectWrite, "o-19");
    const charged = eventsOf(cluster, "charged").length;
    expectThat(cluster, charged === 0, `the canceled task charged ${String(charged)} times`);
    return b;
  },
};

export const s19bCancelAtPayment: RunnableFaultScenario = {
  id: "s19b-cancel-at-payment",
  title:
    "19b: a live holder between its task's cancel request and its next renewal reaches the payment's intent — refused, no gateway request, the reservation undone once, CANCELED",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    const b = await a2aPod(cluster, "b");
    const { SaveIfAbsent } = { SaveIfAbsent: StoreHoldPoint.OutboundSaveIfAbsent };
    const { taskId, held } = await heldTask(cluster, a, "o-19b", SaveIfAbsent);
    // the charge committed before the cancel: it stands, and replays if asked again
    const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
    expectThat(cluster, isAccepted(cancel), `the cancel was refused: ${JSON.stringify(cancel)}`);
    await release(a, held);
    await cluster.ended(taskId);
    await readUntil(cluster, b, taskId, "CANCELED", isCanceled);
    const refused = writeEnd(cluster, a, taskId, SaveIfAbsent)?.error?.name;
    expectThat(
      cluster,
      refused === "ExecutionCancelFencedError",
      `a's intent after the cancel was to be refused (ExecutionCancelFencedError); it was ${refused ?? "accepted"}`,
    );
    const paid = eventsOf(cluster, "step").filter(
      (step) => step.rootExecutionId === taskId && step.point === FaultStepPoint.PayAfter,
    );
    expectThat(
      cluster,
      paid.length === 0,
      `the canceled task's payment went on (${String(paid.length)})`,
    );
    expectThat(
      cluster,
      cluster.gateway.requests.length === 0,
      `the gateway got ${String(cluster.gateway.requests.length)} requests after the cancel`,
    );
    const released = eventsOf(cluster, "released").filter((e) => e.rootExecutionId === taskId);
    expectThat(
      cluster,
      released.length === 1,
      `the reservation was released ${String(released.length)} times`,
    );
    return b;
  },
};
