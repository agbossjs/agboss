import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import type {
  PausedExecutionRepository,
  PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { pauseOf } from "./paused-execution-data.js";

/**
 * #1307 (G3, Q-A): a pause's times are `Date`s in the contract; a store keeps them as it likes (ISO 8601
 * text in a raw column) and hands back a `Date` of the very millisecond it was given. These cases use
 * times with milliseconds and compare by instant: a store that truncates a time, reads text in the
 * wrong zone, hands out the instance it holds, or compares two `Date`s by reference fails one of them.
 */
export type Instances = ContractInstances<PausedExecutionRepository>;
export type Case = ContractCase<PausedExecutionRepository>;
export const R = NO_RECIPIENTS;

/** A moment of the hour of 2026-01-05 10:00, `ms` milliseconds into its first second. */
export const T = (ms: number): Date => new Date(Date.UTC(2026, 0, 5, 10, 0, 0, ms));
/** What the pause below is made with: every one of its times has milliseconds, and each call makes fresh `Date`s. */
export const asked = (): Date => T(11);
export const first = (): Date => T(7);
export const deadline = (): Date => T(123);
export const reminder = (): Date => T(45);
export const cap = (): Date => new Date(Date.UTC(2026, 0, 5, 20, 0, 0, 999));

/** A pending pause every time of which has milliseconds; the moments the cases act at are before 10:00. */
export const preciseOf = (
  pauseId: string,
  stepKey = "run-1:clerk-agent:1:call-1",
): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  askedAt: asked(),
  firstAskedAt: first(),
  maxExpiresAt: cap(),
  expiresAt: deadline(),
  remindAt: reminder(),
  boundAt: T(900),
  expiryBound: PauseExpiryBound.Pause,
  trail: [{ action: "opened", at: asked(), target: "refund-tool-approval", expiresAt: deadline() }],
});

export const stored = async (
  store: PausedExecutionRepository,
  pauseId: string,
): Promise<PauseRecord> => {
  const found = await store.findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) return expect.fail(`pause ${pauseId} is stored`);
  return found;
};

/** The same instant as `at`, in a `Date` that is no one else's. */
export const sameAs = (at: Date): Date => new Date(at.getTime());
/** One millisecond off `at`. */
export const off = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

export const expectInstant = (value: Date | undefined, expected: Date, what: string): void => {
  expect(value, what).toBeInstanceOf(Date);
  expect(value?.getTime(), what).toBe(expected.getTime());
};

/** Every `Date` a pause holds (none for an absent pause): what a caller of a store's own record may move. */
export const datesOf = (pause: PauseRecord | undefined): Date[] =>
  pause === undefined
    ? []
    : [
        pause.askedAt,
        pause.firstAskedAt,
        pause.maxExpiresAt,
        pause.resolvedAt,
        pause.expiresAt,
        pause.remindAt,
        pause.boundAt,
        pause.closedFirst?.resolvedAt,
        ...pause.trail.flatMap((entry) => [entry.at, entry.expiresAt]),
      ].filter((at): at is Date => at !== undefined);

/** Sets to the epoch every `Date` of the pause: what a listener or a caller may do with a record it was handed. */
export const moveDatesOf = (pause: PauseRecord | undefined): void => {
  for (const at of datesOf(pause)) at.setTime(0);
};
