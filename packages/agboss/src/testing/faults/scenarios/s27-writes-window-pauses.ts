import { ExecutionStatus } from "../../../app/types.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { HoldPhase } from "../hold-points.js";
import { FaultWorkflow } from "../pod-protocol.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, heldAt, holdStore, release, takenOverBy } from "./kit.js";
import { answerOn, pausedOrderOn, resumeFinished } from "./pause-kit.js";
import { chargesOf } from "./s22-kit.js";

/**
 * Scenarios 27a and 27b (#1098): a holder loses its tree after an answered question's writes were
 * saved (`putWrites`) and before the checkpoint after them (`put`) — the `put` never answers, the
 * bounded pod hands over at the end of its trust and is killed, its own lease takes held so it
 * cannot take the tree back. LangGraph lists the answered task's old interrupt until the superstep
 * ends; nothing waits there:
 * - 27a, an own-thread child's question (ADR-0022): b's recovery finds no open pause, continues the
 *   root from its checkpoint, and the child from its saved answer — never re-pauses the tree with no
 *   pause to answer: b charges and pays once, the tree finishes;
 * - 27b, the second of two questions in a row, answered on b while a's resume moved the tree (a's
 *   drain took it): b's resume takes the lease after a and finds no answer to take — it moves the
 *   tree on and returns it finished, charged and paid once on b; never a stale paused result,
 *   `NotPausedError` or a finish before the tree's end.
 */

/** The `put` held on `pod` (any thread after the arm): its thread, from the held operation's key. */
async function putHeld(cluster: FaultCluster, pod: FaultPod): Promise<string> {
  const held = await heldAt(cluster, pod, StoreHoldPoint.CheckpointPut);
  return String(held.key);
}

/** Kills `a` once its call `tag` ended with the hand-over. */
async function handedOverAndKilled(cluster: FaultCluster, a: FaultPod, tag: string): Promise<void> {
  const failed = await cluster.next(
    `a's call ${tag} ending with the hand-over`,
    (event) => event.type === "resume-failed" && event.tag === tag,
  );
  expectThat(
    cluster,
    failed.error === "ExecutionLeaseLostError",
    `a's call was to hand over, it failed with ${String(failed.error)}`,
  );
  await a.kill();
}

/** The order's charge ran once, on b, and its payment came from b only. */
function chargedOnceOnB(cluster: FaultCluster, orderId: string, b: FaultPod): void {
  const charged = eventsOf(cluster, "charged").map(
    (event) => `${event.pod}:${String(event.status)}`,
  );
  expectThat(
    cluster,
    charged.join() === `${b.name}:ran`,
    `the charge was to run once, on b; it ran ${charged.join(", ") || "nowhere"}`,
  );
  expectThat(
    cluster,
    chargesOf(cluster, orderId) === b.name,
    `the gateway's payments came from ${chargesOf(cluster, orderId) || "nobody"}, not b only`,
  );
}

export const s27aChildAnswerSaved: RunnableFaultScenario = {
  id: "s27a-child-answer-saved-put-held",
  title:
    "27a: an own-thread child's answered question is saved, its next checkpoint never answers — the next pod continues the child, charges and pays once, the tree finishes",
  run: async (cluster) => {
    const a = await cluster.pod("a", { isBounded: true });
    const b = await cluster.pod("b", { isBounded: true });
    const order = await pausedOrderOn(cluster, a, "o-27a", FaultWorkflow.ChildPause);
    const key = order.rootExecutionId;
    // the first checkpoint after the answer: the child's, after its question's writes (no put before)
    await holdStore(a, StoreHoldPoint.CheckpointPut, undefined);
    const tag = await answerOn(a, order.pauseId);
    const thread = await putHeld(cluster, a);
    // a holds the tree's lease now: it never takes it again
    await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
    expectThat(
      cluster,
      thread.startsWith(`${key}/child/`),
      `the held checkpoint was to be the child's, on ${key}/child/…; it was on ${thread}`,
    );
    await handedOverAndKilled(cluster, a, tag);
    await takenOverBy(cluster, b, key);
    await endedOn(cluster, key, b);
    chargedOnceOnB(cluster, order.orderId, b);
    return b;
  },
};

export const s27bSecondAnswerSaved: RunnableFaultScenario = {
  id: "s27b-second-answer-saved-resume-waits",
  title:
    "27b: the second answer, given on b while a's resume moves the tree, is taken by a and saved, the checkpoint after it never answers — b's waiting resume moves the tree on: finished, charged and paid once",
  run: async (cluster) => {
    const a = await cluster.pod("a", { isBounded: true });
    const b = await cluster.pod("b", { isBounded: true });
    const order = await pausedOrderOn(cluster, a, "o-27b", FaultWorkflow.TwicePause);
    const key = order.rootExecutionId;
    // a stops once its pass sent the second question: the pause is saved, still pending
    await holdStore(a, StoreHoldPoint.PauseMarkSent, undefined, { phase: HoldPhase.After });
    const tagA = await answerOn(a, order.pauseId);
    const sent = await heldAt(cluster, a, StoreHoldPoint.PauseMarkSent);
    const second = String(sent.key);
    expectThat(cluster, second !== order.pauseId, "the held send was the first question's");
    // b answers the second question: recorded `Resolved`, then its call waits for a's lease
    await holdStore(b, StoreHoldPoint.PauseResolve, second, { phase: HoldPhase.After });
    const tagB = await answerOn(b, second);
    await release(b, await heldAt(cluster, b, StoreHoldPoint.PauseResolve, second));
    // a's drain takes b's answer: its question's writes saved, the checkpoint after them held
    await holdStore(a, StoreHoldPoint.CheckpointPut, key);
    await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
    await release(a, sent);
    await putHeld(cluster, a);
    expectThat(
      cluster,
      eventsOf(cluster, "charged").length === 0,
      "nothing was to be charged before the hand-over",
    );
    await handedOverAndKilled(cluster, a, tagA);
    const moved = await resumeFinished(cluster, tagB);
    expectThat(
      cluster,
      moved.pod === b.name &&
        moved.status === ExecutionStatus.Finished &&
        moved.finish === "fault-twice-pause-workflow-finish",
      `b's resume was to return the tree finished at its finish; it returned ${JSON.stringify({ pod: moved.pod, status: moved.status, finish: moved.finish })}`,
    );
    await endedOn(cluster, key, b);
    chargedOnceOnB(cluster, order.orderId, b);
    return b;
  },
};
