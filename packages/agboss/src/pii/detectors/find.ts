import type { PiiKind } from "../kinds.js";
import { FORMAT_DETECTORS, type FormatDetector } from "./formats.js";

/** A range a detector found: `[start, end)` of the text, and its kind. */
export interface FoundRange {
  readonly start: number;
  readonly end: number;
  readonly kind: PiiKind;
  /** The detector's place in `FORMAT_DETECTORS`: the more specific wins a tie. */
  readonly rank: number;
}

/** The range of a match: its `value` group when the pattern has one, else the whole match. */
function rangeOf(match: RegExpExecArray): readonly [number, number] | undefined {
  const value = match.indices?.groups?.value;
  if (value !== undefined) return value;
  return match.indices?.[0];
}

function rangesOf(detector: FormatDetector, rank: number, text: string): FoundRange[] {
  const found: FoundRange[] = [];
  const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
  for (const match of text.matchAll(pattern)) {
    const range = rangeOf(match);
    if (range === undefined) continue;
    const [start, end] = range;
    if (detector.isValid !== undefined && !detector.isValid(text.slice(start, end))) continue;
    found.push({ start, end, kind: detector.kind, rank });
  }
  return found;
}

/** Every range of the given kinds the format detectors find in `text`, validated. */
export function findFormatRanges(text: string, kinds: ReadonlySet<PiiKind>): FoundRange[] {
  if (kinds.size === 0 || text === "") return [];
  return FORMAT_DETECTORS.flatMap((detector, rank) =>
    kinds.has(detector.kind) ? rangesOf(detector, rank, text) : [],
  );
}
