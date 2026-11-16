import { ExecutionStatus } from "../../../app/types.js";
import { systemClock } from "../../../infrastructure/clock.js";
import { seconds } from "../../../units/index.js";
import type { FaultCluster } from "../cluster.js";
import { HoldPhase } from "../hold-points.js";
import { FaultWaitError, type FaultPod } from "../pod.js";
import { FaultWorkflow } from "../pod-protocol.js";
import type { FaultPauseState } from "../pod-pause-state.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { endedOn, eventsOf, expectThat, heldAt, holdStore, release, takenOverBy } from "./kit.js";
import { answerOn, pausedOrderOn, pauseStateOn, resumeFinished } from "./pause-kit.js";

/**
 * Scenarios 29, 29b, 29c and 29d (#1179, #850): a resume's `running` mark and the pod that makes it.
 * The order rests at its first question; pod b answers it. A resume writes its record `running`
 * before it records its answer (#850: a death after that leaves recovery a tree to continue) and
 * never again before it holds the tree's lease — a later write could land on the rest a holder
 * wrote after taking this very answer:
 * - 29: b's call is stopped right after it recorded its answer. a's sweep takes the lease, takes
 *   the answer, runs the step on and rests the tree at the second question. Then b goes on: its
 *   take finds nothing to take, and the record says `paused` — the tree waits at an open pause;
 * - 29b: as 29, and b is killed (SIGKILL) once a rested the tree: the rest stands, the second
 *   answer finishes the order, charged once;
 * - 29c: b is killed (SIGKILL) at once after it recorded its answer, before it took the lease:
 *   a's sweep continues the tree with the answer, taken once, and the order finishes, charged once;
 * - 29d: b is killed (SIGKILL) after its mark and before it recorded its answer: a's recovery rests
 *   the tree at its first question again; the answers then finish the order, charged once.
 */

/** Polls a's reading of the tree until it rests (record `paused`) with `pending` pauses open. */
async function restedWith(
  cluster: FaultCluster,
  pod: FaultPod,
  key: string,
  pending: number,
): Promise<FaultPauseState> {
  const deadline = systemClock.now().getTime() + cluster.waitTimeout;
  for (;;) {
    const state = await pauseStateOn(pod, key);
    const open = state.pauses.filter((pause) => pause.status === "pending").length;
    if (state.rootStatus === "paused" && open === pending) return state;
    if (systemClock.now().getTime() >= deadline)
      throw new FaultWaitError(
        `no tree resting with ${String(pending)} open pause(s) within the wait: ${JSON.stringify(state)}`,
      );
    await systemClock.sleep(seconds(0.1));
  }
}

/** Kills `pod` (SIGKILL) and expects that it died of it. */
async function killed(cluster: FaultCluster, pod: FaultPod): Promise<void> {
  const exit = await pod.kill();
  expectThat(
    cluster,
    exit.signal === "SIGKILL",
    `pod ${pod.name} was to be killed, it exited ${JSON.stringify(exit)}`,
  );
}

/** The open question of the tree on `reader` is answered there: the order ends, charged once. */
async function finishedBy(
  cluster: FaultCluster,
  reader: FaultPod,
  key: string,
  state: FaultPauseState,
): Promise<void> {
  const open = state.pauses.find((pause) => pause.status === "pending");
  await resumeFinished(cluster, await answerOn(reader, open?.pauseId ?? ""));
  await endedOn(cluster, key, reader);
  const charged = eventsOf(cluster, "charged").length;
  expectThat(cluster, charged === 1, `the charge ran ${String(charged)} times, once expected`);
  expectThat(
    cluster,
    eventsOf(cluster, "reserved").length === 1,
    "the reservation ran more than once",
  );
}

/** The tree's second question, open, its record `paused`, on `reader`: what a rest says. */
function expectRestedAtSecond(cluster: FaultCluster, state: FaultPauseState): void {
  expectThat(
    cluster,
    state.rootStatus === "paused" && state.pauses.length === 2,
    `the tree rests at its second question: its record was to say paused, it says ${JSON.stringify(state)}`,
  );
}

export const s29LateRunningMark: RunnableFaultScenario = {
  id: "s29-late-running-mark-on-a-rest",
  title:
    "29: a resume's answer is taken by another pod's sweep, which rests the tree at its next question, before the resume goes on — the resume's late `running` mark does not land: the record says paused",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-29", FaultWorkflow.TwicePause);
    const key = order.rootExecutionId;
    // b records its answer, and its call stops right after: before the take of the lease
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.After });
    const tagB = await answerOn(b, order.pauseId);
    const held = await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    // a's sweep continues the `running` tree with b's answer and rests it at the second question
    await restedWith(cluster, a, key, 1);
    await release(b, held);
    const moved = await resumeFinished(cluster, tagB);
    expectThat(
      cluster,
      moved.pod === b.name && moved.status === ExecutionStatus.Paused,
      `b's resume was to return the tree paused at the second question; it returned ${JSON.stringify({ pod: moved.pod, status: moved.status })}`,
    );
    // read, not sampled: the tree has a closed first pause beside its open second one
    const state = await pauseStateOn(b, key);
    expectRestedAtSecond(cluster, state);
    await finishedBy(cluster, b, key, state);
    return b;
  },
};

export const s29bKilledAfterRest: RunnableFaultScenario = {
  id: "s29b-late-running-mark-pod-killed",
  title:
    "29b: b's resume is stopped after it recorded its answer, a's sweep rests the tree at its next question, b is killed (SIGKILL): the record says paused, the next answer finishes the order, charged once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-29b", FaultWorkflow.TwicePause);
    const key = order.rootExecutionId;
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.After });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    const rested = await restedWith(cluster, a, key, 1);
    await killed(cluster, b);
    expectRestedAtSecond(cluster, rested);
    await finishedBy(cluster, a, key, await pauseStateOn(a, key));
    return a;
  },
};

export const s29cKilledAfterAnswer: RunnableFaultScenario = {
  id: "s29c-killed-after-mark-and-answer-before-lease",
  title:
    "29c: b is killed (SIGKILL) after its mark and its recorded answer, before it takes the lease — a's sweep continues the tree, the answer is taken once, the order is charged once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-29c", FaultWorkflow.TwicePause);
    const key = order.rootExecutionId;
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.After });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    await killed(cluster, b);
    await takenOverBy(cluster, a, key);
    const rested = await restedWith(cluster, a, key, 1);
    expectRestedAtSecond(cluster, rested);
    await finishedBy(cluster, a, key, rested);
    return a;
  },
};

export const s29dKilledAfterMark: RunnableFaultScenario = {
  id: "s29d-killed-after-mark-before-answer",
  title:
    "29d: b is killed (SIGKILL) after its mark, before its answer is recorded — a's recovery rests the tree at its first question again, the answers finish the order, charged once",
  run: async (cluster) => {
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    const order = await pausedOrderOn(cluster, a, "o-29d", FaultWorkflow.TwicePause);
    const key = order.rootExecutionId;
    // the answer's own write is stopped before it is applied: the mark came first (#850)
    await holdStore(b, StoreHoldPoint.PauseResolve, order.pauseId, { phase: HoldPhase.Before });
    await answerOn(b, order.pauseId);
    await heldAt(cluster, b, StoreHoldPoint.PauseResolve, order.pauseId);
    await killed(cluster, b);
    await takenOverBy(cluster, a, key);
    const rested = await restedWith(cluster, a, key, 1);
    expectThat(
      cluster,
      rested.pauses.length === 1 && rested.pauses[0]?.status === "pending",
      `the tree was to rest at its first question again: ${JSON.stringify(rested)}`,
    );
    // the first question's answer, then the second's
    await resumeFinished(cluster, await answerOn(a, rested.pauses[0]?.pauseId ?? ""));
    const second = await restedWith(cluster, a, key, 1);
    await finishedBy(cluster, a, key, second);
    return a;
  },
};
