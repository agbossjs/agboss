import { pauseKeyOf } from "../../../infrastructure/pause-record.js";
import type { PodEventFact } from "../facts.js";
import { HoldPhase } from "../hold-points.js";
import type { FaultPod } from "../pod.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, heldAt, holdStore } from "./kit.js";
import { answerOn, pausedOrderOn, resumeFinished, type PausedOrder } from "./pause-kit.js";

/**
 * Scenario 28 (#946 AC2, parent AC16, AC18): a pod killed (SIGKILL) between a reassignment and the
 * new message. The order rests at a question its thread owner answers; an operator reassigns it to
 * "deputy-3" on pod a, which is held right after the store's transaction answered — the old pause is
 * `Reassigned`, the replacement `Pending` and unsent — and killed before it sent anything. Pod b's
 * timers send the replacement (the look, 30 s on the pods' clock), once, naming the pause it
 * replaces and its assignee; the old id answers nothing ("reassigned"); the deputy's answer finishes
 * the order — reserved, charged and paid once: the step never ran again.
 */

type Cluster = Parameters<RunnableFaultScenario["run"]>[0];

/** The sends of the pause question, in the order the pods told them. */
const sendsOf = (cluster: Cluster): readonly PodEventFact[] => eventsOf(cluster, "pause-sent");

/** Pod `a` reassigns the order's pause and is killed right after the store's transaction answered. */
async function reassignedThenKilled(cluster: Cluster, a: FaultPod, order: PausedOrder) {
  await holdStore(a, StoreHoldPoint.PauseReassign, order.pauseId, { phase: HoldPhase.After });
  await a.command({
    op: "reassign",
    tag: "a:reassign",
    pauseId: order.pauseId,
    assignee: "deputy-3",
  });
  await heldAt(cluster, a, StoreHoldPoint.PauseReassign, order.pauseId);
  expectThat(
    cluster,
    sendsOf(cluster).length === 1,
    `the channel was sent ${String(sendsOf(cluster).length)} times before the kill, once expected: the first ask`,
  );
  const exit = await a.kill();
  expectThat(
    cluster,
    exit.signal === "SIGKILL",
    `pod a was to be killed, it exited ${JSON.stringify(exit)}`,
  );
}

/** Another pod's timers send the replacement within a minute: the event of that send. */
async function resentBy(cluster: Cluster, b: FaultPod, order: PausedOrder): Promise<string> {
  const resent = await cluster.next(
    "the replacement sent again by another pod",
    (event) => event.type === "pause-sent" && event.replacesKey !== undefined,
  );
  const oldKey = pauseKeyOf("default", order.pauseId);
  expectThat(
    cluster,
    resent.pod === b.name && resent.replacesKey === oldKey && resent.assignee === "deputy-3",
    `the replacement was to be sent by b for deputy-3, replacing ${oldKey}; it was ${JSON.stringify(resent)}`,
  );
  expectThat(cluster, resent.pauseId !== order.pauseId, "the replacement had the old pause's id");
  return String(resent.pauseId);
}

export const s28ReassignKill: RunnableFaultScenario = {
  id: "s28-pause-reassign-kill-before-send",
  title:
    "28: a pod killed after a reassignment was written, before the new message — another pod sends it once, the old id answers nothing, the order is reserved, charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-28");
    await reassignedThenKilled(cluster, a, order);
    const newId = await resentBy(cluster, b, order);

    // the old id answers nothing; the deputy's answer finishes the order
    const refused = await answerOn(b, order.pauseId);
    await cluster.next(
      "the old id refused",
      (event) =>
        event.type === "resume-failed" &&
        event.tag === refused &&
        event.error === "PauseClosedError",
    );
    await resumeFinished(cluster, await answerOn(b, newId));
    await endedOn(cluster, order.rootExecutionId, b);
    const resends = sendsOf(cluster).filter((event) => event.replacesKey !== undefined);
    expectThat(cluster, resends.length === 1, "the replacement was sent more than once");
    expectThat(
      cluster,
      eventsOf(cluster, "reserved").length === 1,
      `the reservation ran ${String(eventsOf(cluster, "reserved").length)} times, once expected`,
    );
    return b;
  },
};
