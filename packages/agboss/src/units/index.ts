/**
 * `@agboss/core/units` — values with units, so a limit reads as what it is: `usd(0.5)`,
 * `seconds(30)`, `minutes(5)`, `kilobytes(64)`. Each value is checked once here and carries its unit in its type.
 */
import type { Brand } from "../types/brand.js";

/** An amount of money in US dollars. */
export type Usd = Brand<number, "Usd">;

/** A size in bytes of UTF-8 content — what a model reads of a tool result (#336). */
export type Bytes = Brand<number, "Bytes">;

/** A duration in milliseconds. */
export type Milliseconds = Brand<number, "Milliseconds">;

export class UnitError extends RangeError {
  override name = "UnitError";
}

function nonNegative(amount: number, unit: string): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new UnitError(`${unit} must be a finite number ≥ 0, got ${String(amount)}`);
  }
  return amount;
}

/** US dollars: `usd(0.5)`. */
export const usd = (amount: number): Usd => nonNegative(amount, "usd") as Usd;

/** A size given in kilobytes, 1 KB = 1,024 bytes: `maxResultSize: kilobytes(64)` (#336). */
export const kilobytes = (amount: number): Bytes =>
  (nonNegative(amount, "kilobytes") * 1024) as Bytes;

/** A duration given in seconds. */
export const seconds = (amount: number): Milliseconds =>
  (nonNegative(amount, "seconds") * 1000) as Milliseconds;

/** A duration given in minutes. */
export const minutes = (amount: number): Milliseconds =>
  (nonNegative(amount, "minutes") * 60_000) as Milliseconds;

/** A duration given in hours (a quorum's `deadline`, #279). */
export const hours = (amount: number): Milliseconds =>
  (nonNegative(amount, "hours") * 3_600_000) as Milliseconds;
