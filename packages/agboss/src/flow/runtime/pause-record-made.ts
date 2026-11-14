import { executionsFromRootOf, rootFactsOf, type FrameSpec } from "../context/frame.js";
import { idempotencyKeyOf } from "../context/idempotency.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  newPauseId,
  PauseExpiryBound,
  PauseStatus,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import type { PauseChannel, PauseQuestion } from "./pause.js";
import { plainRecordOf } from "./records.js";

/** The record a pause step makes, and the branch keys it carries (#337): split from `pause.ts`. */

/** What a branch key is made from: a step of an execution. */
export interface BranchKeySite {
  readonly executionId: string;
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly itemIndex?: number | undefined;
}

/** A step's branch key (#337): `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}]`. */
export const branchKeyOf = (site: BranchKeySite): string =>
  idempotencyKeyOf({
    executionId: site.executionId,
    nodeId: site.nodeId,
    visitNumber: site.visitNumber,
    itemIndex: site.itemIndex,
  });

/** The keys of a waiting step and of every step that launched one of its executions (#337). */
function branchKeysAt(frame: FrameSpec): readonly string[] {
  const { execution, step } = frame;
  const launchers = executionsFromRootOf(execution).flatMap((each) =>
    each.parent === undefined
      ? []
      : [branchKeyOf({ ...each.parent.step, executionId: each.parent.execution.executionId })],
  );
  return [...launchers, branchKeyOf({ ...step, executionId: execution.executionId })];
}

/** The deadline fields of a pause asked `now` (#941, D9): the smaller of its own and its run's. */
export function deadlineOf(
  frame: FrameSpec,
  expiresIn: number | undefined,
  now: Date,
): Pick<PauseRecord, "expiresAt" | "expiryBound" | "boundAt"> {
  const run = frame.execution.deadline?.at;
  const own =
    expiresIn === undefined ? undefined : new Date(now.getTime() + expiresIn).toISOString();
  if (own === undefined && run === undefined) return {};
  // a tie goes to the run: its deadline has the final word (D8)
  const isRun = run !== undefined && (own === undefined || run <= own);
  return {
    expiresAt: isRun ? run : own,
    expiryBound: isRun ? PauseExpiryBound.RunDeadline : PauseExpiryBound.Pause,
    ...(run === undefined ? {} : { boundAt: run }),
  };
}

/** The record a step would make: a new id, `Pending`, not sent. */
export function newRecordOf(
  frame: FrameSpec,
  channel: PauseChannel,
  question: PauseQuestion,
  clock: Clock,
): PauseRecord {
  const { execution, step } = frame;
  const now = clock.now();
  return {
    pauseId: newPauseId(),
    tenantId: execution.tenant.tenantId,
    threadId: execution.threadId,
    // inside a child workflow (#263) the record belongs to the tree: its root, the child's own id
    rootExecutionId: rootFactsOf(execution).executionId,
    executionId: execution.executionId,
    workflow: execution.workflow.name,
    stepKey: step.idempotencyKey,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    // a per-item child's own index when its step has none (#263)
    itemIndex: step.itemIndex ?? execution.itemIndex,
    copyNumber: step.copyNumber,
    component: plainRecordOf(question.component ?? step.component),
    ...(step.toolLoopIteration === undefined ? {} : { toolLoopIteration: step.toolLoopIteration }),
    validationAttempts: step.validationAttempts,
    kind: question.kind,
    step: question.step,
    channel: channel.name,
    branchKeys: branchKeysAt(frame),
    answerer: channel.answerer,
    ask: question.ask,
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: now.toISOString(),
    ...deadlineOf(frame, question.expiresIn ?? channel.expiresIn, now),
  };
}
