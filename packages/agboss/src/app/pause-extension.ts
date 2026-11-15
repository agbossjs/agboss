import { isExpiresIn } from "../channels/channel-rules.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import {
  instantAfter,
  reminderOf,
  type AddWorkingTime,
} from "../flow/runtime/pause-record-made.js";
import type { PauseChannel } from "../flow/runtime/pause.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { workingTimeAfter } from "../calendar/calendar-call.js";
import { isWorkingDuration } from "../units/index.js";
import { spanText } from "../units/working-time.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";
import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { pauseKeyOf, PauseStatus, type PauseRecord } from "../infrastructure/pause-record.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import type { AppDeps } from "./app-deps.js";
import { ownDepsOf } from "./own-deps.js";
import type { AnswerParts } from "./resume.js";
import { answeredByOf, pauseOf } from "./resume.js";
import { pauseClosed } from "./pause-closed.js";
import { PauseExtensionContendedError } from "./pause-closed-error.js";
import type { App, ExtendPauseRequest, PauseCallerOptions } from "./types.js";

/**
 * `app.extendPause` (#942, Q7): an operator moves an open pause's deadline later. Who may: as an
 * answer (`answeredBy` for a channel's pause, the thread's `ownerId` for its owner's). The new
 * deadline is `now + expiresIn`; refused when it is not later than the current one, when the pause
 * has no deadline (none is ever added), or when it is past the deadline the pause was made under —
 * its run's, or a quorum's (`boundAt`); exactly that deadline is allowed. A closed pause, or one
 * past its deadline, is `PauseClosedError`. The store applies it atomically (`extend…`, its
 * compare-and-set over the deadline this call read, to a later one, while the pause is open — the
 * expiry look, an answer and another extension: one wins); the channel and the listeners are told
 * `extended` in the same transaction, once, by the winner. A call that loses the compare-and-set
 * `MAX_EXTEND_ATTEMPTS` (8) times in a row is `PauseExtensionContendedError` (`pause.extension-contended`);
 * it changed nothing, retrying is safe. No lease is taken and no tree moves.
 */

/** What an extension needs from the workflow's app. */
export interface ExtendParts extends Pick<AnswerParts, "owned"> {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The workflow's deps: its channels (their `remindBefore`) and who hears of the extension (#940). */
  readonly deps: AppDeps;
}

/** The pause's channel as its workflow has it now: its reminder (#942) and calendar (#944); `undefined`: it is gone. */
function channelOf(deps: AppDeps, pause: PauseRecord): PauseChannel | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).channelOf?.(pause.channel);
  } catch {
    // a channel this workflow no longer has: nobody to remind
    return undefined;
  }
}

function reject(issues: readonly DtoIssue[]): never {
  throw new DtoValidationError({ dto: "ExtendPauseRequest", issues });
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id and a duration. */
function checked(request: unknown): ExtendPauseRequest {
  const pauseId: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "pauseId") : undefined;
  const expiresIn: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "expiresIn") : undefined;
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  if (!isExpiresIn(expiresIn))
    reject([
      {
        path: ".expiresIn",
        reason: `${spanText(expiresIn)} is no duration — a positive finite one of at least seconds(1) and at most 5 years, like hours(24) or workingHours(8)`,
      },
    ]);
  return { pauseId, expiresIn };
}

/** The deadline an extension of `pause` to `expiresAt` moves from; refused when it may not move there. */
function previousDeadlineOf(pause: PauseRecord, expiresAt: string): string {
  const { expiresAt: current, boundAt } = pause;
  if (current === undefined)
    return reject([{ path: ".pauseId", reason: "the pause has no deadline: none is added to it" }]);
  if (expiresAt <= current)
    return reject([
      {
        path: ".expiresIn",
        reason: `the new deadline ${expiresAt} is not later than the current one, ${current}`,
      },
    ]);
  if (boundAt !== undefined && expiresAt > boundAt)
    return reject([
      {
        path: ".expiresIn",
        reason: `the new deadline ${expiresAt} is past the deadline the pause is bound by, ${boundAt}`,
      },
    ]);
  return current;
}

/** The pause open and not yet past its deadline, or why it is not. */
async function assertOpen(parts: ExtendParts, pause: PauseRecord): Promise<void> {
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
}

/**
 * A plain `expiresIn` for a pause whose role reminds in working time is refused (#944): a calendar
 * cannot subtract — the run-time twin of `[channel.remind-before-working-without-working-expiry]`.
 */
function assertSameKind(request: ExtendPauseRequest, channel: PauseChannel | undefined): void {
  if (isWorkingDuration(channel?.remindBefore) && !isWorkingDuration(request.expiresIn))
    reject([
      {
        path: ".expiresIn",
        reason: "this role reminds in working time: extend it with workingHours / workingMinutes",
      },
    ]);
}

/**
 * The pause's calendar as the extension asks it (#944), in the pause's frame — its execution's
 * tenant and fields — read from the stores only when working time is asked. A pause whose channel
 * has no calendar now (a deploy took it away) is refused working time.
 */
function calendarAdder(
  parts: ExtendParts,
  pause: PauseRecord,
  channel: PauseChannel | undefined,
): AddWorkingTime {
  const { deps, clock } = parts;
  let framed: Promise<FrameSpec> | undefined;
  const frameOf = async (): Promise<FrameSpec> =>
    pauseFrameOf(
      deps,
      pause,
      await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId)),
    );
  return async (from, amount) => {
    if (channel?.calendar === undefined)
      return reject([
        {
          path: ".expiresIn",
          reason: "this pause's channel has no working calendar: extend it with hours / minutes",
        },
      ]);
    framed ??= frameOf();
    const site = { calendar: channel.calendar, tenantId: pause.tenantId, role: pause.channel };
    return workingTimeAfter({ ...site, frame: await framed, clock, log: deps.log }, from, amount);
  };
}

/**
 * How many times an extension reads and tries before it gives up with `PauseExtensionContendedError`.
 * A lost compare-and-set means another writer moved the deadline in the same instant; each retry
 * re-reads, so losing again needs yet another writer to win in between. Eight lost rounds in a row
 * is a hot pause, not a normal race (a handful of operators clicking together settle in two or three),
 * and an unbounded loop would hold the caller; a typed error lets it decide.
 */
export const MAX_EXTEND_ATTEMPTS = 8;

/**
 * `app.extendPause` of one workflow's app. The store's compare-and-set decides: the write applies
 * only over the deadline this call read and only to a later one. A call that lost re-reads the
 * pause and decides again — refused when it is closed, or when its new deadline is not later than
 * the one that won (a shorter extension that raced a longer one), tried again over the new
 * deadline when it is still later. "Extended" is told only for a write that won, and
 * `previousExpiresAt` is the deadline that write replaced (#1099).
 */
export const extendPauseOf =
  (parts: ExtendParts): App["extendPause"] =>
  async (given, call: PauseCallerOptions = {}) => {
    parts.accepting();
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    checkedCallers("PauseCallerOptions", { ...call, tenantId });
    const request = checked(given);
    let pause = await pauseOf(parts.pauses, request, tenantId);
    await answeredByOf(parts, pause, call);
    for (let attempt = 1; attempt <= MAX_EXTEND_ATTEMPTS; attempt += 1) {
      await assertOpen(parts, pause);
      const channel = channelOf(parts.deps, pause);
      assertSameKind(request, channel);
      const now = parts.clock.now();
      const add = calendarAdder(parts, pause, channel);
      const expiresAt = (await instantAfter(request.expiresIn, now, add)).toISOString();
      const previousExpiresAt = previousDeadlineOf(pause, expiresAt);
      const remindAt = await reminderOf(
        now,
        { expiresAt, expiresIn: request.expiresIn },
        channel?.remindBefore,
        add,
      );
      const extended = await parts.pauses.extendByTenantIdAndPauseId(
        tenantId,
        pause.pauseId,
        { expiresAt, previousExpiresAt, ...(remindAt === undefined ? {} : { remindAt }) },
        now,
        recipientsIn(parts.deps.pause, pause),
      );
      if (extended !== undefined) {
        noticesWritten(parts.deps.pause);
        return { pauseKey: pauseKeyOf(tenantId, pause.pauseId), expiresAt, previousExpiresAt };
      }
      // lost the compare-and-set: the expiry, an answer, a cancel or another extension won — read what it left
      pause = await pauseOf(parts.pauses, request, tenantId);
    }
    throw new PauseExtensionContendedError({
      pauseKey: pauseKeyOf(tenantId, request.pauseId),
      attempts: MAX_EXTEND_ATTEMPTS,
    });
  };
