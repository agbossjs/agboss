import { A2A_START_LOST } from "../../../a2a/tasks/a2a-task-repair.js";
import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { a2aCall, a2aPod, FaultSkill, orderMessage, readUntil } from "./a2a-kit.js";
import { eventsOf, expectThat } from "./kit.js";
import {
  frozenAccept,
  gaveUp,
  isCallTimeout,
  isStartLost,
  keepsOf,
  settledOnBoth,
} from "./s17-kit.js";

/**
 * Scenario 17 under the store-call bound (#1059): the pod that is frozen or held keeps the bound, as
 * production runs. A thawed or held pod meets its overdue bound before its held call is answered, so
 * the held call is released only after the pod logged `store.call-timeout`: its give-up always
 * comes first, whatever the load. Expected outcomes, each pinned below:
 *
 * - 17 (bounded): a is frozen before its start's claim, b's read fences the id (`FAILED
 *   a2a.start-lost`), a thaws, its claim is given up and its late claim refused (kept before): no
 *   start, no step.
 * - 17b (bounded): a is frozen with its claim applied and unanswered; b's fence loses to it and
 *   writes the tree's cancel request, `FAILED a2a.start-lost` a start timeout later; a thaws and its
 *   start is given up at its bound — it never reaches its first lease take: no step.
 * - 17c: a's claim is applied and never answered, a not frozen: the start is given up at 15 s and
 *   settles the task itself, `FAILED store.call-timeout` (decided in #928's spec log: the start's
 *   outcome is unknown, and an immediate honest answer beats waiting for a read repair); no step, and
 *   every read and a resend of the message say the same.
 * - 17d: a's accept saved the task and never heard of it: the accept answers `-32603` at the bound
 *   (nothing started); b's read settles the task `FAILED a2a.start-lost` a start timeout later.
 */

const ERROR_INTERNAL = -32603;

export const s17AcceptCrashBounded: RunnableFaultScenario = {
  id: "s17-a2a-accept-crash-bounded",
  title:
    "17 (bounded): a pod frozen before its start's claim keeps the bound — another pod's read fences the id, FAILED start-lost; the thawed claim is given up and refused, nothing runs",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a", { isBounded: true });
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17-bounded", "o-17-bounded", FaultSkill.Order);
    const { taskId, sent, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.LeaseClaimExecutionId,
      "m-17-bounded",
      "o-17-bounded",
      HoldPhase.Before,
    );
    // its answer, told before the freeze: a frozen pod's late answer would read as a task gone back
    await sent;
    await a.freeze();
    await readUntil(cluster, b, taskId, `FAILED ${A2A_START_LOST}`, isStartLost);
    expectThat(
      cluster,
      keepsOf(cluster, b, taskId).includes(true),
      `b's fence of ${taskId} did not keep the id: ${JSON.stringify(keepsOf(cluster, b, taskId))}`,
    );
    a.thaw();
    await gaveUp(cluster, a);
    await go();
    await cluster.until(`a's refused keep of ${taskId}`, () =>
      keepsOf(cluster, a, taskId).includes(false),
    );
    await settledOnBoth(cluster, [a, b], taskId, () => a2aCall(cluster, b, "SendMessage", message));
    return b;
  },
};

export const s17bIdKeptCrashBounded: RunnableFaultScenario = {
  id: "s17b-a2a-id-kept-crash-bounded",
  title:
    "17b (bounded): a pod frozen with its claim applied and unanswered keeps the bound — the read cancels its tree, FAILED start-lost a start timeout later; the thawed start is given up and runs nothing",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a", { isBounded: true });
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17b-bounded", "o-17b-bounded", FaultSkill.Order);
    const { taskId, sent, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.LeaseClaimExecutionId,
      "m-17b-bounded",
      "o-17b-bounded",
    );
    // its answer, told before the freeze: a frozen pod's late answer would read as a task gone back
    await sent;
    await a.freeze();
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
    a.thaw();
    await gaveUp(cluster, a);
    await go();
    await settledOnBoth(cluster, [a, b], taskId, () => a2aCall(cluster, a, "SendMessage", message));
    return b;
  },
};

export const s17cClaimNeverAnswers: RunnableFaultScenario = {
  id: "s17c-a2a-claim-never-answers",
  title:
    "17c: an A2A start whose claim of the task's id is applied and never answered — given up at its bound, the task settles FAILED store.call-timeout, nothing runs, a resend reads the same task",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a", { isBounded: true });
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17c", "o-17c", FaultSkill.Order);
    const { taskId, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.LeaseClaimExecutionId,
      "m-17c",
      "o-17c",
    );
    await gaveUp(cluster, a);
    await go();
    const read = await readUntil(cluster, b, taskId, "FAILED store.call-timeout", isCallTimeout);
    expectThat(cluster, read.state === A2ATaskState.Failed, `b read ${JSON.stringify(read)}`);
    await settledOnBoth(
      cluster,
      [a, b],
      taskId,
      () => a2aCall(cluster, b, "SendMessage", message),
      {
        isSettled: isCallTimeout,
        what: "FAILED store.call-timeout",
      },
    );
    return b;
  },
};

export const s17dAcceptNeverAnswers: RunnableFaultScenario = {
  id: "s17d-a2a-accept-never-answers",
  title:
    "17d: an A2A accept whose task save is applied and never answered — the client gets -32603 at the bound, nothing starts; another pod's read settles the task FAILED start-lost",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a", { isBounded: true });
    const b = await a2aPod(cluster, "b");
    const message = orderMessage("m-17d", "o-17d", FaultSkill.Order);
    const { taskId, go } = await frozenAccept(
      cluster,
      a,
      StoreHoldPoint.A2ATaskSaveIfAbsent,
      "m-17d",
      "o-17d",
    );
    await gaveUp(cluster, a);
    const answered = await go();
    expectThat(
      cluster,
      answered.errorCode === ERROR_INTERNAL,
      `a's accept was to answer ${String(ERROR_INTERNAL)} at its bound; it answered ${JSON.stringify(answered)}`,
    );
    await readUntil(cluster, b, taskId, `FAILED ${A2A_START_LOST}`, isStartLost);
    expectThat(
      cluster,
      eventsOf(cluster, "step").every((event) => event.rootExecutionId !== taskId),
      `the task ${taskId} ran a step`,
    );
    await settledOnBoth(cluster, [a, b], taskId, () => a2aCall(cluster, b, "SendMessage", message));
    return b;
  },
};
