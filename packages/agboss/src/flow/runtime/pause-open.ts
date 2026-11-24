import type { ChannelSelectContext } from "../../channels/pause-contexts.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { PauseRecord } from "../../infrastructure/pause-record.js";
import type { PauseAnswerLog } from "../../infrastructure/pause-answer-log.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import type { Class } from "../../components/injection.js";
import type { PauseNotices } from "../../pause/index.js";
import { isWorkingDuration, type WorkingDuration } from "../../units/index.js";
import {
  workingReminderAt,
  workingTimeAfter,
  type CalendarSite,
} from "../../calendar/calendar-call.js";
import { rootFactsOf, type FrameSpec } from "../context/frame.js";
import type { ChooseChannel, PauseChannel, PauseTarget, PendingOpening } from "./pause-channel.js";
import { trailEntryOf } from "./pause-chain.js";
import { newRecordOf, type RemindAt } from "./pause-record-made.js";
import type { PauseQuestion } from "./pause.js";

/** Where a pause step goes: the store, the channel, the step's frame and its signal. */
export interface PauseStepSite {
  readonly pauses: PausedExecutionRepository;
  /** The execution records: a pause its channel decided at once is logged there (#267 S107). */
  readonly answers: PauseAnswerLog;
  readonly target: PauseTarget;
  readonly frame: FrameSpec;
  readonly signal: AbortSignal | undefined;
  /** The application's clock: when the pause was asked and decided. */
  readonly clock: Clock;
  /** Validates a decision the channel gave at once (as a reply would be), before it is recorded. */
  readonly validate: (decision: unknown) => unknown;
  /** Reported once, before the channel is asked (`onChannelStart`). */
  readonly onSend: () => Promise<void>;
  /** Who hears of the pause's change (#940): `markSent` writes its notices. */
  readonly notices?: PauseNotices | undefined;
  /** Where a calendar that fails is logged (#944). */
  readonly log?: FrameworkLog | undefined;
}

/**
 * The pause of the step's key: the record it made, or the one it already has. A deadline in working
 * time asks the calendar, so a re-entry looks for the record first and never asks it again; a race
 * between two instances is decided by `findOrCreateByStepKey`.
 */
export async function openedPause(
  site: PauseStepSite,
  question: PauseQuestion,
): Promise<PauseRecord> {
  const { pauses, target, frame } = site;
  const { tenantId } = frame.execution.tenant;
  // working time asks the calendar, a selector asks the project's code: neither runs again for a re-entry
  if (isWorkingDuration(target.timeout) || target.select !== undefined) {
    const found = await pauses.findByTenantIdAndRootExecutionIdAndStepKey(
      tenantId,
      rootFactsOf(frame.execution).executionId,
      frame.step.idempotencyKey,
    );
    if (found !== undefined) return found;
  }
  const calendarSite: CalendarSite = {
    calendar: target.calendar,
    tenantId,
    role: target.name,
    frame,
    clock: site.clock,
    interruption: site.signal,
    log: site.log,
  };
  const add = (from: Date, amount: WorkingDuration): Promise<Date> =>
    workingTimeAfter(calendarSite, from, amount);
  const remind: RemindAt = (span) => workingReminderAt(calendarSite, span);
  const choose: ChooseChannel = (opening) => chosenChannel(target, question, opening);
  return pauses.findOrCreateByStepKey(
    await newRecordOf(frame, target, question, site.clock, add, remind, choose),
  );
}

/** Why a target's channel could not be chosen: a message that names the target and the problem, never the pause's data. */
export class ChannelSelectError extends Error {
  override name = "ChannelSelectError";

  constructor(target: string, problem: string, options?: ErrorOptions) {
    super(`pause target ${target}: ${problem}`, options);
  }
}

/** The channel a new pause is sent through: the only one, or the one its `@ChannelSelector` picks; none for an owner's target. */
async function chosenChannel(
  target: PauseTarget,
  question: PauseQuestion,
  opening: PendingOpening,
): Promise<PauseChannel | undefined> {
  const channels = [...target.channels.values()];
  if (channels.length <= 1) return channels[0];
  if (target.select === undefined)
    throw new ChannelSelectError(
      target.name,
      `${String(channels.length)} channels and no @ChannelSelector`,
    );
  const ctx: ChannelSelectContext<never> = {
    input: question.input as never,
    ...(question.toolCall === undefined ? {} : { toolCall: question.toolCall }),
    ...(opening.expiresAt === undefined ? {} : { expiresAt: opening.expiresAt }),
    trail: opening.trail.map(trailEntryOf),
  };
  let picked: Class;
  try {
    picked = await target.select(ctx as never);
  } catch (error) {
    throw new ChannelSelectError(target.name, "its @ChannelSelector failed", { cause: error });
  }
  const found = channels.find((channel) => channel.cls === picked);
  if (found === undefined)
    throw new ChannelSelectError(
      target.name,
      "its @ChannelSelector named a class that serves no channel of it",
    );
  return found;
}
