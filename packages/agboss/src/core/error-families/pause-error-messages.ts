import { timeText } from "./time-text.js";
import type { ExpiryProblem, PauseClosedReason } from "../../infrastructure/pause-record.js";
import { pauseKeyOf } from "../../infrastructure/pause-record.js";
import type { WorkingCalendarProblem } from "../../calendar/working-calendar.js";

/** The sentences of the `PauseError` variants made of their facts: never of a handler's, a calendar's or a stored text. */

/** What `PauseError.Closed` says: the pause by its key (never its id), why and when it closed. */
export const closedMessageOf = (
  facts: Partial<{
    readonly pauseId: string;
    readonly tenantId: string;
    readonly reason: PauseClosedReason;
    readonly closedAt: Date;
  }>,
): string =>
  facts.pauseId === undefined || facts.tenantId === undefined
    ? "the pause was closed before the answer came"
    : `pause ${pauseKeyOf(facts.tenantId, facts.pauseId)} is closed: ${facts.reason ?? "closed"} at ${timeText(facts.closedAt, "an unknown time")}`;

/** What `PauseError.UpdateContended` says: the pause's key and how often the call lost. */
export const updateContendedMessageOf = (
  facts: Partial<{ readonly pauseKey: string; readonly attempts: number }>,
): string =>
  facts.pauseKey === undefined
    ? "two updates of one pause raced"
    : `setPauseTimeout of pause ${facts.pauseKey} lost its compare-and-set ${String(facts.attempts ?? 0)} times to other writers`;

/** What `PauseError.ExpiryHandlerFailed` says: the channel and the problem, never the handler's text. */
export const expiryHandlerFailedMessageOf = (
  facts: Partial<{ readonly channel: string; readonly problem: ExpiryProblem }>,
): string =>
  facts.channel === undefined || facts.problem === undefined
    ? "a pause's expiry handler failed"
    : `channel ${facts.channel}: its expiry decision ${facts.problem}`;

/** What `PauseError.WorkingCalendar` says: the calendar and the problem, never the calendar's text. */
export const workingCalendarMessageOf = (
  facts: Partial<{ readonly calendar: string; readonly problem: WorkingCalendarProblem }>,
): string =>
  facts.calendar === undefined || facts.problem === undefined
    ? "a working-calendar deadline cannot be computed"
    : `working calendar ${facts.calendar}: ${facts.problem}`;
