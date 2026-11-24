/**
 * `@agboss/core/units` — values with units, so a limit reads as what it is: `usd(0.5)`,
 * `seconds(30)`, `minutes(5)`, `kilobytes(64)`. Each value is checked once here and carries its unit in its type.
 */
import { shownLimit } from "../graph/count-limit.js";
import type { Brand } from "../types/brand.js";
import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";

export type { PlainErrorOptions };

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
 * A value out of range, as the platform's `RangeError`, so `catch` keeps telling it from other errors;
 * made as every framework error is (#906): `{ message, cause }`, with a literal `code`.
 */
export class UnitError extends RangeError {
  static readonly code = "config.unit" as const;
  readonly code = UnitError.code;
  override name = "UnitError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

function nonNegative(amount: number, unit: string): number {
  if (!Number.isFinite(amount) || amount < 0) {
    // a number is printed, anything else by its kind: what was passed may be stored text (#1373)
    throw new UnitError({
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

/** The key a working duration keeps its amount under (a shared symbol: every copy of the package agrees). */
const workingDuration: unique symbol = Symbol.for("agboss.units.working-duration");

/**
 * Working time (#944): a duration the pause's calendar counts — its working days, hours, breaks and
 * holidays — not the wall clock. Counted by the pause's calendar, not the wall clock.
 */
export interface WorkingDuration {
  /** The amount of working time, in milliseconds. */
  readonly [workingDuration]: Milliseconds;
}

function working(amount: number, unit: string, size: number): WorkingDuration {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UnitError({
      message: `${unit} must be a positive finite number, got ${shownLimit(amount)}`,
    });
  }
  return Object.freeze({ [workingDuration]: (amount * size) as Milliseconds });
}

/** Working time given in hours: `expiresIn: workingHours(2)`. */
export const workingHours = (amount: number): WorkingDuration =>
  working(amount, "workingHours", 3_600_000);

/** Working time given in minutes: `remindBefore: workingMinutes(30)`. */
export const workingMinutes = (amount: number): WorkingDuration =>
  working(amount, "workingMinutes", 60_000);

/** Working time given in minutes: `remindBefore: workMin(30)`. */
export const workMin = (amount: number): WorkingDuration => working(amount, "workMin", 60_000);

/** Working time given in hours: `expiresIn: workHours(2)`. */
export const workHours = (amount: number): WorkingDuration =>
  working(amount, "workHours", 3_600_000);

/**
 * Working time given in days: `expiresIn: workDays(2)`. Until #1310b gives it calendar semantics a
 * working day counts as 24 hours of working time.
 */
export const workDays = (amount: number): WorkingDuration =>
  working(amount, "workDays", 86_400_000);

/** Whether a value is working time (`workingHours(…)` / `workingMinutes(…)`). */
export const isWorkingDuration = (value: unknown): value is WorkingDuration =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, workingDuration) === "number";
