import { compareInstants, copyOf, instantOfText, isBefore } from "../../infrastructure/instants.js";
import { definedFields } from "../../core/defined-fields.js";
import { executionsFromRootOf, type FrameSpec } from "../context/frame.js";
import { idempotencyKeyOf } from "../context/idempotency.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  newPauseId,
  PauseExpiryBound,
  PauseStatus,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import type { PauseEscalationCounts } from "../../infrastructure/pause-limits-stored.js";
import { onlyChannelOf, type ChooseChannel, type PauseTarget } from "./pause-channel.js";
import type { PauseQuestion } from "./pause.js";
import { openedEntryOf, placeOf, type OpeningHooks } from "./pause-record-facts.js";
import { isWorkingDuration, type WorkingDuration } from "../../units/index.js";
import type { ReminderSpan } from "../../calendar/calendar-call.js";
import type { TimeSpan } from "../../units/working-time.js";

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

/**
 * The deadline fields of a pause asked `now` (#941, D9; #945): the smallest of its own, its run's and
 * its quorum's. A tie goes to the run (its deadline has the final word, D8), else to the quorum
 * over the pause's own; `boundAt` is the smaller of the run's and the quorum's: no extension passes it.
 */
export function deadlineOf(
  frame: FrameSpec,
  expiresIn: number | undefined,
  now: Date,
): Pick<PauseRecord, "expiresAt" | "expiryBound" | "boundAt"> {
  const own = expiresIn === undefined ? undefined : new Date(now.getTime() + expiresIn);
  return boundedDeadlineOf(frame, own);
}

/** The instant a frame's deadline text names: only the canonical `toISOString()` text a frame is made with is read. */
const frameInstantOf = (text: string | undefined): Date | undefined =>
  text === undefined ? undefined : instantOfText(text, "execution deadline", "execution");

/**
 * The deadline fields of a pause whose own deadline is `own` (an instant: plain time added, or
 * the calendar's answer for working time): the smallest of it, its run's and its quorum's (#945).
 * A tie goes to the run (D8), else to the quorum over the pause's own; `boundAt` is the smaller of
 * the run's and the quorum's: no extension passes it.
 */
export function boundedDeadlineOf(
  frame: FrameSpec,
  own: Date | undefined,
): Pick<PauseRecord, "expiresAt" | "expiryBound" | "boundAt"> {
  const run = frameInstantOf(frame.execution.deadline?.at);
  const quorum = frameInstantOf(frame.execution.quorumDeadlineAt);
  const bounds = [
    { at: run, bound: PauseExpiryBound.RunDeadline },
    { at: quorum, bound: PauseExpiryBound.Quorum },
    { at: own, bound: PauseExpiryBound.Pause },
  ].flatMap(({ at, bound }) => (at === undefined ? [] : [{ at, bound }]));
  // earliest first; on a tie the order above (run, quorum, own) decides
  const [first] = [...bounds].sort((a, b) => compareInstants(a.at, b.at));
  if (first === undefined) return {};
  const [boundAt] = [run, quorum].filter((at) => at !== undefined).sort(compareInstants);
  return {
    expiresAt: first.at,
    expiryBound: first.bound,
    ...(boundAt === undefined ? {} : { boundAt }),
  };
}

/**
 * The reminder of a pause with the deadline `expiresAt` (#942, Q6): `remindBefore` before it — and
 * none when that is not after `at` (the pause is asked, or extended, less than a reminder's lead
 * before its deadline), nor without a deadline or a `remindBefore`.
 */
export function remindAtOf(
  expiresAt: Date | undefined,
  remindBefore: number | undefined,
  at: Date,
): Date | undefined {
  if (expiresAt === undefined || remindBefore === undefined) return undefined;
  const remindAt = expiresAt.getTime() - remindBefore;
  return remindAt > at.getTime() ? new Date(remindAt) : undefined;
}

/*
 * Working time (#944): the calendar is asked for the instant of the deadline, and — when the reminder
 * is working time too — for the reminder's, from the same start; a plain reminder is subtracted from
 * the deadline as in #942.
 */

/** Adds working time to a start: the pause's calendar, asked. */
export type AddWorkingTime = (from: Date, amount: WorkingDuration) => Promise<Date>;

/**
 * Where a working reminder falls, by the pause's calendar (`workingReminderAt`): walked back from the
 * deadline on a `WorkingWeek`-backed calendar, forward on a calendar of the project's own. Without
 * one, `reminderOf` adds `expiresIn − remindBefore` to the start, in one unit only.
 */
export type RemindAt = (span: ReminderSpan) => Promise<Date | undefined>;

/** The instant `span` runs out after `from`; the calendar is asked only for working time. */
export async function instantAfter(span: TimeSpan, from: Date, add: AddWorkingTime): Promise<Date> {
  return isWorkingDuration(span) ? add(from, span) : new Date(from.getTime() + span);
}

/** The instant an `expiresIn` runs out after `from`; `undefined` without one. */
export async function ownDeadlineOf(
  expiresIn: TimeSpan | undefined,
  from: Date,
  add: AddWorkingTime,
): Promise<Date | undefined> {
  return expiresIn === undefined ? undefined : instantAfter(expiresIn, from, add);
}

/**
 * The reminder of a pause asked (or extended) at `at` whose deadline is `expiresAt` (after the
 * run's or the quorum's bound clamped it): kept only strictly between `at` and `expiresAt`.
 * A working `remindBefore` needs a working `expiresIn` (none without one). With `remind` — the
 * pause's calendar — the reminder is walked back from the deadline (#1310b); without it, it is
 * `calendar.add(at, expiresIn − remindBefore)` in one unit (none, and no calendar call, when that
 * is not positive). A plain `remindBefore` is `expiresAt − remindBefore` as in #942.
 */
export async function reminderOf(
  at: Date,
  deadline: { readonly expiresAt: Date | undefined; readonly expiresIn: TimeSpan | undefined },
  remindBefore: TimeSpan | undefined,
  add: AddWorkingTime,
  remind?: RemindAt,
): Promise<Date | undefined> {
  const { expiresAt, expiresIn } = deadline;
  if (expiresAt === undefined || remindBefore === undefined) return undefined;
  if (!isWorkingDuration(remindBefore)) return remindAtOf(expiresAt, remindBefore, at);
  if (expiresIn === undefined || !isWorkingDuration(expiresIn)) return undefined;
  if (remind !== undefined) {
    return remind({ at, expiresAt: copyOf(expiresAt), expiresIn, remindBefore });
  }
  return addedReminderOf(at, expiresAt, { expiresIn, remindBefore }, add);
}

/** The reminder a calendar that can only add places: `expiresIn − remindBefore` after `at`, in one unit. */
async function addedReminderOf(
  at: Date,
  expiresAt: Date,
  spans: { readonly expiresIn: WorkingDuration; readonly remindBefore: WorkingDuration },
  add: AddWorkingTime,
): Promise<Date | undefined> {
  const { expiresIn, remindBefore } = spans;
  const lead = expiresIn.amount - remindBefore.amount;
  if (expiresIn.unit !== remindBefore.unit || lead <= 0) return undefined;
  const remindAt = await add(at, { ...expiresIn, amount: lead });
  return remindAt.getTime() > at.getTime() && isBefore(remindAt, expiresAt) ? remindAt : undefined;
}

/**
 * The deadline fields of a pause opened `now`: its own wait, capped by the target's total-wait limit,
 * bounded by the run's and quorum's; and that limit's instant (`maxExpiresAt`, counted from `now`).
 */
async function openingDeadlineOf(
  frame: FrameSpec,
  target: PauseTarget,
  expiresIn: TimeSpan | undefined,
  at: { readonly now: Date; readonly add: AddWorkingTime },
): Promise<{
  readonly deadline: Pick<PauseRecord, "expiresAt" | "expiryBound" | "boundAt">;
  readonly maxExpiresAt: Date | undefined;
}> {
  const own = await ownDeadlineOf(expiresIn, at.now, at.add);
  // the target's total-wait limit caps the pause's own wait, never the run's or a quorum's bound
  const max = await ownDeadlineOf(target.escalationLimits?.maxTotalTimeout, at.now, at.add);
  const isCapped = own !== undefined && max !== undefined && isBefore(max, own);
  return { deadline: boundedDeadlineOf(frame, isCapped ? max : own), maxExpiresAt: max };
}

/** When a pause opened `now` waits until, at most, and when it is reminded: its deadline fields, the total-wait limit and the reminder. */
async function openingTimesOf(
  opened: { readonly frame: FrameSpec; readonly target: PauseTarget; readonly hooks: OpeningHooks },
  at: { readonly now: Date; readonly add: AddWorkingTime; readonly remind: RemindAt | undefined },
) {
  const { frame, target, hooks } = opened;
  const expiresIn = hooks.timeout ?? target.timeout;
  const { deadline, maxExpiresAt } = await openingDeadlineOf(frame, target, expiresIn, at);
  const spans = { expiresAt: deadline.expiresAt, expiresIn };
  const remindAt = await reminderOf(at.now, spans, target.remindBefore, at.add, at.remind);
  return { deadline, maxExpiresAt, remindAt };
}

/** The counts of the target's `escalationLimits` a pause carries: the pause's own copy, narrowed by moves. */
const countsOf = (target: PauseTarget): PauseEscalationCounts => {
  const { maxExtensions, maxReassignments } = target.escalationLimits ?? {};
  return definedFields({ maxExtensions, maxReassignments });
};

/** The record a step would make: a new id, `Pending`, not sent; working time asks the calendar (`add`). */
export async function newRecordOf(
  frame: FrameSpec,
  target: PauseTarget,
  question: PauseQuestion,
  clock: Clock,
  add: AddWorkingTime,
  remind?: RemindAt,
  choose: ChooseChannel = onlyChannelOf(target),
  hooks: OpeningHooks = {},
): Promise<PauseRecord> {
  const now = clock.now();
  const { deadline, maxExpiresAt, remindAt } = await openingTimesOf(
    { frame, target, hooks },
    { now, add, remind },
  );
  const { assignees } = hooks;
  const channel = await choose({
    ...definedFields({
      expiresAt: deadline.expiresAt === undefined ? undefined : copyOf(deadline.expiresAt),
      assignees,
    }),
    trail: [openedEntryOf(target, undefined, now, deadline.expiresAt, assignees)],
  });
  return {
    pauseId: newPauseId(),
    ...placeOf(frame, question),
    kind: question.kind,
    step: question.step,
    target: target.name,
    branchKeys: branchKeysAt(frame),
    respondent: target.respondent,
    input: question.input,
    trail: [openedEntryOf(target, channel, now, deadline.expiresAt, assignees)],
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: now,
    // the limits are materialized here and read from the record from now on (#1307, Q-D)
    firstAskedAt: now,
    escalationLimits: countsOf(target),
    ...deadline,
    ...definedFields({
      channel: channel?.name,
      toolCall: question.toolCall,
      assignees,
      remindAt,
      maxExpiresAt,
    }),
  };
}
