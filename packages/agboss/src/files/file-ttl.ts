import { Ttl, type Milliseconds } from "../units/index.js";

/** What is wrong with a policy's `ttl`: a whole number of milliseconds from 1, or `Ttl.Forever`. */
export function ttlProblemsOf(ttl: Milliseconds | Ttl | undefined): readonly string[] {
  if (ttl === undefined || ttl === Ttl.Forever) return [];
  if (typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 1) return [];
  return ["ttl is not a whole number of milliseconds from 1, or Ttl.Forever"];
}

/** How long a ttl keeps a file, in milliseconds: `Infinity` for ever. */
export const ttlMillisOf = (ttl: Milliseconds | Ttl.Forever): number =>
  ttl === Ttl.Forever ? Number.POSITIVE_INFINITY : ttl;

/** How a child's ttl is longer than its parent's, as a text; none when it is as short or shorter. */
export function ttlExcessOf(
  parent: Milliseconds | Ttl.Forever,
  child: Milliseconds | Ttl.Forever,
): readonly string[] {
  return ttlMillisOf(child) > ttlMillisOf(parent)
    ? [`ttl ${String(child)} is above ${String(parent)}`]
    : [];
}
