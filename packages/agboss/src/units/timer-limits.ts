import { shownLimit } from "../graph/count-limit.js";
import { UnitError, type Milliseconds } from "./index.js";

/**
 * The longest delay a Node timer takes (#1141): above 2^31 − 1 ms (about 24.8 days) `setTimeout`
 * clamps the delay to 1 ms and warns `TimeoutOverflowWarning`, so a timer set to a larger value
 * fires at once — a shutdown that gives up immediately, an undo that times out immediately.
 */
export const MAX_TIMER_DELAY = 2_147_483_647 as Milliseconds;

/**
 * The largest value of a setting that bounds one call, wait or stop (`shutdownTimeout`,
 * `compensationTimeout`, `outboundCalls.attemptTimeout`, a tool's, a model provider's, a health
 * check's, `fileFetchTimeout`, a retry's delay, `close({ timeout })`, one A2A call's `timeout`):
 * 24 hours. Documented on the Wiki's Configuration page.
 */
export const MAX_TIMEOUT = 86_400_000 as Milliseconds;

/**
 * The largest value of a setting that bounds a whole task or launch (a quorum's `deadline`, the
 * A2A listener's `maxTaskDuration`, `execute({ deadline })`): 24 days — under the timer's limit.
 */
export const MAX_DEADLINE = 2_073_600_000 as Milliseconds;

/** `1 day`, `24 days`: a cap as the text of a message. */
const shownCap = (max: number): string =>
  max % 86_400_000 === 0
    ? `${String(max / 86_400_000)} ${max === 86_400_000 ? "day" : "days"}`
    : `${String(max)} ms`;

/**
 * What is wrong with `value` as a timer-backed duration, or `undefined`: a number not above `max`
 * is fine (its sign or a zero is the setting's own rule). `NaN` is refused too, as is `Infinity`:
 * a timer set to them fires at once.
 */
export function timerProblemOf(
  field: string,
  value: number,
  max: Milliseconds,
): string | undefined {
  // a value that is no number (untyped code, parsed JSON) is no duration either, and is named by its kind (#1373)
  if (typeof value !== "number" || Number.isNaN(value))
    return `${field} is ${shownLimit(value)}, not a duration`;
  if (value <= max) return undefined;
  return `${field} is ${String(value)} ms, above its largest of ${shownCap(max)} (${String(max)} ms) — a longer timer would fire at once`;
}

/** `value` unchanged when `timerProblemOf` finds nothing; else a `UnitError` naming the field. */
export function checkedTimer(field: string, value: number, max: Milliseconds): Milliseconds {
  const problem = timerProblemOf(field, value, max);
  if (problem !== undefined) throw new UnitError({ message: problem });
  return value as Milliseconds;
}
