/**
 * `@agboss/core/units` — values with units, so a limit reads as what it is: `usd(0.5)`,
 * `seconds(30)`, `minutes(5)`, `kilobytes(64)`. Each value is checked once here and carries its unit in its type.
 */
import { shownLimit } from "../graph/count-limit.js";
import type { Brand } from "../types/brand.js";
import { ConfigError } from "../core/error-families/config-errors.js";

/** An amount of money in US dollars. */
export type Usd = Brand<number, "Usd">;

/** A size in bytes of UTF-8 content — what a model reads of a tool result (#336). */
export type Bytes = Brand<number, "Bytes">;

/** A duration in milliseconds. */
export type Milliseconds = Brand<number, "Milliseconds">;

/**
 * How long something is kept, beyond a duration (#1318): `Ttl.Forever` is never swept, `Ttl.None` is not kept
 * at all. `env.ttl("HISTORY_TTL")` reads a duration, `forever` and, when it allows `none`, `none`.
 */
export enum Ttl {
  /** Kept for ever: no sweep deletes it. */
  Forever = "forever",
  /** Not kept: nothing is written. */
  None = "none",
}

/**
 * "No deadline" where a duration is asked (#1318): `app.setPauseTimeout({ pauseId, timeout: Timeout.None })`
 * takes a pause's deadline away.
 */
export enum Timeout {
  /** No deadline: the pause waits until it is answered, cancelled or reassigned. */
  None = "none",
}

function nonNegative(amount: number, unit: string): number {
  if (!Number.isFinite(amount) || amount < 0) {
    // a number is printed, anything else by its kind: what was passed may be stored text (#1373)
    throw new ConfigError.Unit({
      message: `${unit} must be a finite number ≥ 0, got ${shownLimit(amount)}`,
    });
  }
  return amount;
}

/** US dollars: `usd(0.5)`. */
export const usd = (amount: number): Usd => nonNegative(amount, "usd") as Usd;

/** A size given in kilobytes, 1 KB = 1,024 bytes: `maxResultSize: kilobytes(64)` (#336). */
export const kilobytes = (amount: number): Bytes =>
  (nonNegative(amount, "kilobytes") * 1024) as Bytes;

/** A size given in megabytes, 1 MB = 1,048,576 bytes: `maxFileSize: megabytes(10)` (#899). */
export const megabytes = (amount: number): Bytes =>
  (nonNegative(amount, "megabytes") * 1024 * 1024) as Bytes;

/** A duration given in seconds. */
export const seconds = (amount: number): Milliseconds =>
  (nonNegative(amount, "seconds") * 1000) as Milliseconds;

/** A duration given in minutes. */
export const minutes = (amount: number): Milliseconds =>
  (nonNegative(amount, "minutes") * 60_000) as Milliseconds;

/** A duration given in hours (a quorum's `deadline`, #279). */
export const hours = (amount: number): Milliseconds =>
  (nonNegative(amount, "hours") * 3_600_000) as Milliseconds;

/** A size in bytes: `bytes(512)`. */
export const bytes = (amount: number): Bytes => nonNegative(amount, "bytes") as Bytes;

/** A size in kilobytes, 1 KB = 1,024 bytes: `kb(64)`. */
export const kb = (amount: number): Bytes => (nonNegative(amount, "kb") * 1024) as Bytes;

/** A size in megabytes, 1 MB = 1,048,576 bytes: `mb(5)`. */
export const mb = (amount: number): Bytes => (nonNegative(amount, "mb") * 1024 ** 2) as Bytes;

/** A size in gigabytes, 1 GB = 1,073,741,824 bytes: `gb(1)`. */
export const gb = (amount: number): Bytes => (nonNegative(amount, "gb") * 1024 ** 3) as Bytes;

/** A size in terabytes, 1 TB = 1,099,511,627,776 bytes: `tb(1)`. */
export const tb = (amount: number): Bytes => (nonNegative(amount, "tb") * 1024 ** 4) as Bytes;

/** A duration in milliseconds: `ms(250)`. */
export const ms = (amount: number): Milliseconds => nonNegative(amount, "ms") as Milliseconds;

/** A duration in seconds: `sec(30)`. */
export const sec = (amount: number): Milliseconds =>
  (nonNegative(amount, "sec") * 1000) as Milliseconds;

/** A duration in minutes: `min(5)`. */
export const min = (amount: number): Milliseconds =>
  (nonNegative(amount, "min") * 60_000) as Milliseconds;

/** A duration in calendar days of 24 hours: `days(7)`. */
export const days = (amount: number): Milliseconds =>
  (nonNegative(amount, "days") * 86_400_000) as Milliseconds;

/** The key that tells a working duration from any other object (a shared symbol: every copy of the package agrees). */
const workingDuration: unique symbol = Symbol.for("agboss.units.working-duration");

/** What a working duration counts in: working milliseconds, or whole working days of the resolved schedule. */
export type WorkingUnit = "ms" | "days";

/**
 * Working time (#944, #1310): a duration the pause's calendar counts — its working days, hours,
 * breaks and holidays — not the wall clock. `unit` says what `amount` counts: `"ms"` working
 * milliseconds (`workMin`, `workHours`), `"days"` working days of the calendar's schedule
 * (`workDays`): a working day is one active working date, however long its shifts, so `workDays(2)`
 * is two days of the schedule, never 48 hours.
 */
export interface WorkingDuration {
  /** What tells a working duration from any other object. */
  readonly [workingDuration]: true;
  /** What `amount` counts: working milliseconds, or working days. */
  readonly unit: WorkingUnit;
  /** Working milliseconds for `"ms"`, working days for `"days"`; positive and finite. */
  readonly amount: number;
}

function working(amount: number, name: string, unit: WorkingUnit, size: number): WorkingDuration {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConfigError.Unit({
      message: `${name} must be a positive finite number, got ${shownLimit(amount)}`,
    });
  }
  return Object.freeze({ [workingDuration]: true as const, unit, amount: amount * size });
}

/** Working time given in hours: `expiresIn: workingHours(2)`. */
export const workingHours = (amount: number): WorkingDuration =>
  working(amount, "workingHours", "ms", 3_600_000);

/** Working time given in minutes: `remindBefore: workingMinutes(30)`. */
export const workingMinutes = (amount: number): WorkingDuration =>
  working(amount, "workingMinutes", "ms", 60_000);

/** Working time given in minutes: `remindBefore: workMin(30)`. */
export const workMin = (amount: number): WorkingDuration =>
  working(amount, "workMin", "ms", 60_000);

/** Working time given in hours: `expiresIn: workHours(2)`. */
export const workHours = (amount: number): WorkingDuration =>
  working(amount, "workHours", "ms", 3_600_000);

/**
 * Working time given in days: `expiresIn: workDays(2)`. A working day is one active working date of
 * the pause's calendar, counted on its resolved schedule (not 24 hours): a day with no working time
 * (a weekend, a holiday) is not counted, and a start in the middle of a shift counts the rest of
 * that day in proportion.
 */
export const workDays = (amount: number): WorkingDuration => working(amount, "workDays", "days", 1);

/** Whether a value is working time (`workingHours(…)` / `workingMinutes(…)`). */
export const isWorkingDuration = (value: unknown): value is WorkingDuration =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, workingDuration) === true &&
  (Reflect.get(value, "unit") === "ms" || Reflect.get(value, "unit") === "days") &&
  typeof Reflect.get(value, "amount") === "number";
