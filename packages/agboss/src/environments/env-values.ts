import { Ttl, usd, type Bytes, type Milliseconds, type Usd } from "../units/index.js";

/**
 * How the typed readers of `env` (#1324) read a variable's text: `undefined` when it does not parse, so the
 * start names the variable and what it was to be, never its value.
 */

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;
const MILLISECONDS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `30d`, `24h`, `15m`, `10s`, `500ms`, `2w`. */
export function durationOf(raw: string): Milliseconds | undefined {
  const match = DURATION.exec(raw.trim());
  const unit = match?.[2];
  const amount = Number(match?.[1]);
  return unit === undefined ? undefined : ((amount * (MILLISECONDS[unit] ?? 1)) as Milliseconds);
}

const FOREVER: string = Ttl.Forever;
const NONE: string = Ttl.None;

/** A duration, `forever` — and `none` where the option allows it. */
export const ttlOf =
  (allowNone: boolean) =>
  (raw: string): Milliseconds | Ttl | undefined => {
    const text = raw.trim().toLowerCase();
    if (text === FOREVER) return Ttl.Forever;
    if (text === NONE) return allowNone ? Ttl.None : undefined;
    return durationOf(text);
  };

const BYTES = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/;
const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

/** `64kb`, `10mb`, `512b`, `1gb` (1 KB = 1,024 bytes, as `kilobytes()`). */
export function bytesOf(raw: string): Bytes | undefined {
  const match = BYTES.exec(raw.trim().toLowerCase());
  const unit = match?.[2];
  return unit === undefined ? undefined : ((Number(match?.[1]) * (BYTE_UNITS[unit] ?? 1)) as Bytes);
}

/** A finite number. */
export function numberOf(raw: string): number | undefined {
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** An amount of dollars, `0.5`, `40`. */
export function usdOf(raw: string): Usd | undefined {
  const value = numberOf(raw);
  return value === undefined || value < 0 ? undefined : usd(value);
}
