import { A2A_START_LOST } from "../../../a2a/tasks/a2a-task-repair.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  isTerminalA2ATaskState,
} from "../../../infrastructure/a2a-task.repository.js";
import type { FaultRun, PodEventFact } from "../facts.js";
import { compareAt, type HistoryOperation } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";
import { canceledViolations, effectsOf, factsOf, outputOf } from "./a2a-cancels.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * One execution per A2A task, its end for good (#811 AC4, design §4.3.2), from what the test was
 * told over A2A (each answer a pod's `a2a-answer` event), the pods' events, the kept records and
 * the store history — on every task id any of them names (an answer, a call, a saved task, a status
 * write, a kept execution id, a step's tree, a kept root record), so a task no caller heard of is
 * checked too:
 * - no caller is told another state after a terminal one, and no status write is accepted after a
 *   terminal one (asked once it was answered);
 * - the accepted status writes of a task form one version chain — each from the version the one
 *   before wrote, none twice: no update lost;
 * - its id is kept once (`claimExecutionId` answered "kept" once, over every process), and
 *   one root record is kept under it;
 * - a task settled `FAILED a2a.start-lost` ran no step and committed no effect;
 * - a canceled task: `a2a-cancels.ts`.
 */

const A2A = "a2a-answer";

/** Every task id the run names. */
function taskIdsOf(run: FaultRun): readonly string[] {
  const fromEvents = run.events.flatMap((event) => {
    if ((event.type === A2A || event.type === "a2a-asked") && typeof event.taskId === "string")
      return [event.taskId];
    return event.type === "step" && typeof event.rootExecutionId === "string"
      ? [event.rootExecutionId]
      : [];
  });
  const fromHistory = run.history.operations.flatMap(({ invoke, complete }) => {
    if (invoke.key === undefined || complete === undefined || complete.error !== undefined)
      return [];
    const isSaved =
      invoke.operation === StoreHoldPoint.A2ATaskSaveIfAbsent &&
      outputOf(complete).status === A2ATaskSaveStatus.Saved;
    const isOther =
      invoke.operation === StoreHoldPoint.A2ATaskStatusWrite ||
      invoke.operation === StoreHoldPoint.LeaseClaimExecutionId;
    return isSaved || isOther ? [invoke.key] : [];
  });
  const fromRecords = run.records.map((record) => record.executionId);
  return [...new Set([...fromEvents, ...fromHistory, ...fromRecords])];
}

/** Whether `state` (an answer's or a write's) is one a task never leaves. */
export const isTerminal = (state: unknown): boolean =>
  Object.values(A2ATaskState).some((known) => known === state && isTerminalA2ATaskState(known));

/** The answers the test was told of `taskId`, in order. */
const answersOf = (run: FaultRun, taskId: string): readonly PodEventFact[] =>
  run.events.filter((event) => event.type === A2A && event.taskId === taskId);

/** No caller told another state once one was told the task ended. */
function toldViolations(taskId: string, answers: readonly PodEventFact[]): FaultViolation[] {
  const ended = answers.find((answer) => isTerminal(answer.state));
  if (ended === undefined) return [];
  return answers
    .slice(answers.indexOf(ended) + 1)
    .filter((answer) => answer.state !== undefined && answer.state !== ended.state)
    .map((answer) =>
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId} was told ${String(ended.state)} on ${ended.pod}, then ${String(answer.state)} on ${answer.pod}`,
      ),
    );
}

/** The status writes of `taskId` the store accepted. */
export const acceptedWritesOf = (run: FaultRun, taskId: string): readonly HistoryOperation[] =>
  run.history.operations.filter(
    ({ invoke, complete }) =>
      invoke.operation === StoreHoldPoint.A2ATaskStatusWrite &&
      invoke.key === taskId &&
      complete?.error === undefined &&
      complete?.output !== undefined &&
      complete.output !== null,
  );

const stateOf = (write: HistoryOperation): unknown => outputOf(write.complete).state;

/** No write accepted once a terminal one was. */
function writtenViolations(writes: readonly HistoryOperation[], taskId: string): FaultViolation[] {
  const ended = [...writes]
    .sort((left, right) => compareAt(left.complete?.at ?? "0", right.complete?.at ?? "0"))
    .find((write) => isTerminal(stateOf(write)));
  const endedAt = ended?.complete?.at;
  if (ended === undefined || endedAt === undefined) return [];
  return writes
    .filter((write) => write !== ended && compareAt(write.invoke.at, endedAt) > 0)
    .map((write) =>
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId}'s status ${String(stateOf(write))} was written by ${write.invoke.process} after it was written ${String(stateOf(ended))}`,
      ),
    );
}

/** The accepted writes, one version chain: each from the version written before it, none twice. */
function chainViolations(writes: readonly HistoryOperation[], taskId: string): FaultViolation[] {
  const links = writes
    .map((write) => ({
      from: Number(factsOf(write.invoke.input).expectedVersion),
      to: Number(outputOf(write.complete).version),
      by: write.invoke.process,
    }))
    .sort((left, right) => left.to - right.to);
  const isChain = links.every(
    (link, at) => link.to === link.from + 1 && (at === 0 || links[at - 1]?.to === link.from),
  );
  if (isChain) return [];
  return [
    violation(
      FaultInvariant.A2ATasksOnce,
      `task ${taskId}'s status writes are no version chain: ${links.map((each) => `${String(each.from)}→${String(each.to)} by ${each.by}`).join(", ")} — an update was lost`,
    ),
  ];
}

/** Its id kept once, one root record under it. */
function executionViolations(run: FaultRun, taskId: string): FaultViolation[] {
  const kept = run.history.operations.filter(
    ({ invoke, complete }) =>
      invoke.operation === StoreHoldPoint.LeaseClaimExecutionId &&
      invoke.key === taskId &&
      outputOf(complete).kept === true,
  );
  const roots = run.records.filter((record) => record.executionId === taskId);
  return [
    ...(kept.length > 1
      ? [
          violation(
            FaultInvariant.A2ATasksOnce,
            `execution id ${taskId} was kept ${String(kept.length)} times (by ${kept.map(({ invoke }) => invoke.process).join(", ")}): two starts under one task`,
          ),
        ]
      : []),
    ...(roots.length > 1
      ? [
          violation(
            FaultInvariant.A2ATasksOnce,
            `task ${taskId} has ${String(roots.length)} root records: ${roots.map((record) => record.status).join(", ")}`,
          ),
        ]
      : []),
  ];
}

/** Whether the task was settled start-lost: told so, or written so. */
const isStartLost = (answers: readonly PodEventFact[], writes: readonly HistoryOperation[]) =>
  answers.some((answer) => answer.code === A2A_START_LOST) ||
  writes.some((write) => outputOf(write.complete).errorCode === A2A_START_LOST);

/** A task settled start-lost ran no step, committed no effect. */
function startLostViolations(run: FaultRun, taskId: string, isLost: boolean): FaultViolation[] {
  if (!isLost) return [];
  const steps = run.events.filter(
    (event) => event.type === "step" && event.rootExecutionId === taskId,
  );
  const effects = effectsOf(run, taskId);
  if (steps.length === 0 && effects.length === 0) return [];
  const ran = steps.map((step) => `${String(step.point)} on ${step.pod}`);
  const committed = effects.map(({ invoke }) => `${invoke.operation} by ${invoke.process}`);
  return [
    violation(
      FaultInvariant.A2ATasksOnce,
      `task ${taskId} was settled ${A2A_START_LOST}, yet ran ${[...ran, ...committed].join(", ")}`,
    ),
  ];
}

/** Every violation of one execution per A2A task, its end for good. */
export function a2aTaskViolations(run: FaultRun): FaultViolation[] {
  return taskIdsOf(run).flatMap((taskId) => {
    const answers = answersOf(run, taskId);
    const writes = acceptedWritesOf(run, taskId);
    return [
      ...toldViolations(taskId, answers),
      ...writtenViolations(writes, taskId),
      ...chainViolations(writes, taskId),
      ...executionViolations(run, taskId),
      ...startLostViolations(run, taskId, isStartLost(answers, writes)),
      ...canceledViolations(run, taskId, answers, writes),
    ];
  });
}
