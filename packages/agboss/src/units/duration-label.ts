/**
 * A duration as a person writes it (#941, `agboss describe`): the largest unit that divides it —
 * `24 h`, `90 min`, `30 s`, `1500 ms`.
 */
const UNITS: readonly (readonly [string, number])[] = [
  ["h", 3_600_000],
  ["min", 60_000],
  ["s", 1000],
];

export function durationLabel(ms: number): string {
  const unit = UNITS.find(([, size]) => ms >= size && ms % size === 0);
  return unit === undefined ? `${String(ms)} ms` : `${String(ms / unit[1])} ${unit[0]}`;
}
