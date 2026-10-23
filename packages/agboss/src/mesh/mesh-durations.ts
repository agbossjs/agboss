import type { Milliseconds } from "../units/index.js";

/**
 * Durations and amounts on the wire (#398): units in the values — an ISO 8601 duration of seconds
 * (`PT58.2S`), an amount as a decimal string (`"0.42"`); never `Ms` / `Usd` in a field's name.
 */

const DURATION = /^PT(\d{1,9}(?:\.\d{1,3})?)S$/;

/** `PT58.2S` for 58 200 ms (to the millisecond, never negative). */
export const isoDurationOf = (delay: number): string =>
  `PT${String(Math.max(0, Math.round(delay)) / 1000)}S`;

/** The milliseconds of `PT58.2S`; `undefined` for anything else. */
export function millisecondsOf(duration: string | undefined): Milliseconds | undefined {
  const seconds = duration === undefined ? undefined : DURATION.exec(duration)?.[1];
  return seconds === undefined ? undefined : (Math.round(Number(seconds) * 1000) as Milliseconds);
}

/** `"0.42"` for $0.42 (to a millionth of a dollar, never negative). */
export const amountOf = (usd: number): string => String(Math.max(0, Math.round(usd * 1e6) / 1e6));

/** The dollars of `"0.42"`; `undefined` for anything that is not a non-negative decimal. */
export function dollarsOf(amount: string | undefined): number | undefined {
  if (amount === undefined || !/^\d{1,12}(?:\.\d{1,9})?$/.test(amount)) return undefined;
  return Number(amount);
}
