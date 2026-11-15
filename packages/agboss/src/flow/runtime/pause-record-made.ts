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
import { isWorkingDuration } from "../../units/index.js";
import { amountOf, type TimeSpan } from "../../units/working-time.js";

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
  const own =
    expiresIn === undefined ? undefined : new Date(now.getTime() + expiresIn).toISOString();
  return boundedDeadlineOf(frame, own);
}

/**
 * The deadline fields of a pause whose own deadline is `own` (an ISO instant: plain time added, or
 * the calendar's answer for working time): the smaller of it and its run's. A tie goes to the run.
 */
export function boundedDeadlineOf(
  frame: FrameSpec,
  own: string | undefined,
): Pick<PauseRecord, "expiresAt" | "expiryBound" | "boundAt"> {
  const run = frame.execution.deadline?.at;
  if (own === undefined && run === undefined) return {};
  // a tie goes to the run: its deadline has the final word (D8)
  const isRun = run !== undefined && (own === undefined || run <= own);
  return {
    expiresAt: isRun ? run : own,
    expiryBound: isRun ? PauseExpiryBound.RunDeadline : PauseExpiryBound.Pause,
    ...(run === undefined ? {} : { boundAt: run }),
  };
}

/**
 * The reminder of a pause with the deadline `expiresAt` (#942, Q6): `remindBefore` before it — and
 * none when that is not after `at` (the pause is asked, or extended, less than a reminder's lead
 * before its deadline), nor without a deadline or a `remindBefore`.
 */
export function remindAtOf(
  expiresAt: string | undefined,
  remindBefore: number | undefined,
  at: Date,
): string | undefined {
  if (expiresAt === undefined || remindBefore === undefined) return undefined;
  const remindAt = Date.parse(expiresAt) - remindBefore;
  return remindAt > at.getTime() ? new Date(remindAt).toISOString() : undefined;
}

/*
 * Working time (#944): the calendar is asked for the instant of the deadline, and — when the reminder
 * is working time too — for the reminder's, from the same start; a plain reminder is subtracted from
 * the deadline as in #942.
 */

/** Adds working time to a start: the pause's calendar, asked. */
export type AddWorkingTime = (from: Date, amount: number) => Promise<Date>;

/** The instant `span` runs out after `from`; the calendar is asked only for working time. */
export async function instantAfter(span: TimeSpan, from: Date, add: AddWorkingTime): Promise<Date> {
  return isWorkingDuration(span) ? add(from, amountOf(span)) : new Date(from.getTime() + span);
}

/** The ISO instant an `expiresIn` runs out after `from`; `undefined` without one. */
export async function ownDeadlineOf(
  expiresIn: TimeSpan | undefined,
  from: Date,
  add: AddWorkingTime,
): Promise<string | undefined> {
  return expiresIn === undefined
    ? undefined
    : (await instantAfter(expiresIn, from, add)).toISOString();
}

/**
 * The reminder of a pause asked (or extended) at `at` whose deadline is `expiresAt` (after the
 * run's or the quorum's bound clamped it): kept only strictly between `at` and `expiresAt`.
 * Working `remindBefore` counts working time before a working `expiresIn` (`calendar.add(at,
 * expiresIn − remindBefore)`, none — and no calendar call — when that is not positive); it
 * needs a working `expiresIn` (a calendar cannot subtract): none without one. A plain
 * `remindBefore` is `expiresAt − remindBefore` as in #942.
 */
export async function reminderOf(
  at: Date,
  deadline: { readonly expiresAt: string | undefined; readonly expiresIn: TimeSpan | undefined },
  remindBefore: TimeSpan | undefined,
  add: AddWorkingTime,
): Promise<string | undefined> {
  const { expiresAt, expiresIn } = deadline;
  if (expiresAt === undefined || remindBefore === undefined) return undefined;
  if (!isWorkingDuration(remindBefore)) return remindAtOf(expiresAt, remindBefore, at);
  if (expiresIn === undefined || !isWorkingDuration(expiresIn)) return undefined;
  const lead = amountOf(expiresIn) - amountOf(remindBefore);
  if (lead <= 0) return undefined;
  const remindAt = await add(at, lead);
  return remindAt.getTime() > at.getTime() && remindAt.toISOString() < expiresAt
    ? remindAt.toISOString()
    : undefined;
}

/** The record a step would make: a new id, `Pending`, not sent; working time asks the calendar (`add`). */
export async function newRecordOf(
  frame: FrameSpec,
  channel: PauseChannel,
  question: PauseQuestion,
  clock: Clock,
  add: AddWorkingTime,
): Promise<PauseRecord> {
  const { execution, step } = frame;
  const now = clock.now();
  const expiresIn = question.expiresIn ?? channel.expiresIn;
  const deadline = boundedDeadlineOf(frame, await ownDeadlineOf(expiresIn, now, add));
  const remindAt = await reminderOf(
    now,
    { expiresAt: deadline.expiresAt, expiresIn },
    channel.remindBefore,
    add,
  );
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
    ...deadline,
    ...(remindAt === undefined ? {} : { remindAt }),
  };
}
