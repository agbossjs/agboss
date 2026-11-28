import { isBefore, isDeadlineDue } from "../infrastructure/instants.js";
import { trailOf } from "../flow/runtime/pause-chain.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import { checkedTimeout, resolvedTimeoutBy } from "../flow/runtime/pause-hooks.js";
import { instantAfter, reminderOf } from "../flow/runtime/pause-record-made.js";
import { definedFields } from "../core/defined-fields.js";
import type { PauseDeadlineSet } from "../infrastructure/pause-notices.js";
import { PauseExpiryBound, type PauseRecord } from "../infrastructure/pause-record.js";
import type { TimeSpan } from "../units/working-time.js";
import { calendarOfTarget, type CalendarParts } from "./pause-calendar.js";
import { limitExceeded } from "./pause-limits.js";

/**
 * The deadline a reassignment sets (#1307d): the call's `timeout`, else the destination's own
 * (`resolveTimeout` or `timeout`), counted from now by the destination's calendar for the assignees
 * the pause has after the change — capped by the chain's `maxTotalTimeout` and by the run's or
 * quorum's bound. Split from `pause-reassign-plan.ts`.
 */

/** What the deadline is computed for. */
export interface DeadlineAsk {
  readonly timeout?: TimeSpan | undefined;
  readonly isExpiry: boolean;
}

/** The bound a pause waits under when its own run's or quorum's deadline clamps it. */
const boundKindOf = (pause: PauseRecord): PauseExpiryBound =>
  pause.expiryBound === PauseExpiryBound.Quorum
    ? PauseExpiryBound.Quorum
    : PauseExpiryBound.RunDeadline;

/** How long the pause waits from now: the call's, else the destination's own. */
async function spanOf(
  pause: PauseRecord,
  to: PauseTarget,
  assignees: readonly string[] | undefined,
  asked: TimeSpan | undefined,
): Promise<TimeSpan | undefined> {
  if (asked !== undefined) return checkedTimeout(to, asked);
  const facts = { input: pause.input, toolCall: pause.toolCall, trail: trailOf(pause), assignees };
  return (await resolvedTimeoutBy(to, facts)) ?? to.timeout;
}

/** The earlier of the deadlines given, and which bound it is (the pause's own unless the run's or quorum's clamps it). */
function clamped(
  pause: PauseRecord,
  own: Date | undefined,
  cap: Date | undefined,
): { expiresAt: Date | undefined; expiryBound: PauseExpiryBound } {
  // the cap only counts when it is earlier than the pause's own deadline, or the pause has none
  const earlier = cap === undefined || (own !== undefined && !isBefore(cap, own)) ? own : cap;
  const { boundAt } = pause;
  // the run's or quorum's bound takes it only when strictly earlier: a tie stays the pause's own
  if (boundAt !== undefined && (earlier === undefined || isBefore(boundAt, earlier)))
    return { expiresAt: boundAt, expiryBound: boundKindOf(pause) };
  return { expiresAt: earlier, expiryBound: PauseExpiryBound.Pause };
}

/** The deadline after the reassignment; `undefined`: the pause keeps its own. */
export async function deadlineAfter(
  parts: CalendarParts,
  pause: PauseRecord,
  moves: { readonly from: PauseTarget; readonly to: PauseTarget },
  assignees: readonly string[] | undefined,
  ask: DeadlineAsk,
  maxExpiresAt: Date | undefined,
): Promise<PauseDeadlineSet | undefined> {
  const { from, to } = moves;
  // a pause that stays under its target keeps its deadline, unless the call says otherwise; an expiry always sets one
  if (ask.timeout === undefined && to === from && !ask.isExpiry) return undefined;
  const span = await spanOf(pause, to, assignees, ask.timeout);
  const now = parts.clock.now();
  const { add, remind } = calendarOfTarget(parts, pause, to, assignees);
  const own = span === undefined ? undefined : await instantAfter(span, now, add);
  const bound = clamped(pause, own, maxExpiresAt);
  if (isDeadlineDue(bound.expiresAt, now)) throw limitExceeded(pause, "maxTotalTimeout");
  return withReminder({ now, span, bound, to, calendar: { add, remind } });
}

/** The bound deadline with its reminder, when the target reminds and the deadline is its own span. */
async function withReminder(site: {
  readonly now: Date;
  readonly span: TimeSpan | undefined;
  readonly bound: { expiresAt: Date | undefined; expiryBound: PauseExpiryBound };
  readonly to: PauseTarget;
  readonly calendar: Pick<ReturnType<typeof calendarOfTarget>, "add" | "remind">;
}): Promise<PauseDeadlineSet> {
  const { now, span, bound, to, calendar } = site;
  const { expiresAt, expiryBound } = bound;
  if (expiresAt === undefined) return {};
  const base = { expiresAt, expiryBound };
  if (span === undefined) return base;
  const spans = { expiresAt, expiresIn: span };
  const remindAt = await reminderOf(now, spans, to.remindBefore, calendar.add, calendar.remind);
  return { ...base, ...definedFields({ remindAt }) };
}
