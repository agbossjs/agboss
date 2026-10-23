/** How the HTML report writes numbers (#397 PR 1): money, shares, durations, sizes. */

/** USD with four decimals, as `agboss eval run` prints it. */
export const usdText = (amount: number): string => `$${amount.toFixed(4)}`;

/** `3/4 (75%)`; `0/0` for a suite without cases. */
export function shareText(count: number, total: number): string {
  if (total === 0) return `${String(count)}/0`;
  return `${String(count)}/${String(total)} (${String(Math.round((count / total) * 100))}%)`;
}

/** The time between two ISO 8601 instants: `850 ms`, `12.4 s`, `3 min 5 s`; empty when unreadable. */
export function durationText(startedAt: string, endedAt: string): string {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  if (elapsed < 1000) return `${String(elapsed)} ms`;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)} s`;
  const seconds = Math.round(elapsed / 1000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;

/** A file's size: `812 B`, `48.2 KB`, `1.9 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < KILOBYTE) return `${String(bytes)} B`;
  if (bytes < MEGABYTE) return `${(bytes / KILOBYTE).toFixed(1)} KB`;
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}
