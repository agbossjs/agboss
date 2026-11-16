/**
 * `@agboss/core/units` — values with units, so a limit reads as what it is: `usd(0.5)`,
 * `seconds(30)`, `minutes(5)`, `kilobytes(64)`. Each value is checked once here and carries its unit in its type.
 */
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
    throw new UnitError({ message: `${unit} must be a finite number ≥ 0, got ${String(amount)}` });
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
      message: `${unit} must be a positive finite number, got ${String(amount)}`,
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

/** Whether a value is working time (`workingHours(…)` / `workingMinutes(…)`). */
export const isWorkingDuration = (value: unknown): value is WorkingDuration =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, workingDuration) === "number";
