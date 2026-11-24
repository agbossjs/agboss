/**
 * The regions of an image a redaction model names (#899 §6): strictly checked, each a fraction of the
 * image, and nothing the model wrote in any message — only which region and what is wrong with it.
 */

/**
 * The padding of a region, as a part of its size: 10 % along a line of text, half a line above and below — a
 * vision model's boxes are often a little off vertically, and a digit half under a box is a digit leaked.
 * Two bounds, because a box's error is about a line, not about the whole region: the vertical padding is at
 * most 5 % of the image (a tall block does not black out its neighbours), and the sideways padding is at
 * least a quarter of the region's height, up to 3 % (a short token — a CVV — keeps no digit out of its box).
 */
const PADDING_X = 0.1;
const PADDING_Y = 0.5;
const MAX_PADDING_Y = 0.05;
const MIN_PADDING_X_OF_HEIGHT = 0.25;
const MAX_MIN_PADDING_X = 0.03;

/** The most regions taken from one answer (#1257): more fails the redaction. */
export const MAX_REGIONS = 200;

/**
 * The target of a region the model named with one it was not asked for (#1301): the region is
 * painted all the same — the model found something there — and the target is this constant, never
 * the model's own text.
 */
export const UNKNOWN_TARGET = "(unknown target)";

/** A region the model named, validated: fractions of the image. */
export interface Region {
  readonly target: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const isFraction = (value: unknown, min: number, max: number, isMinOpen: boolean): boolean =>
  typeof value === "number" && (isMinOpen ? value > min : value >= min) && value <= max;

/** The JSON of the model's answer: bare, or inside a code fence; `undefined` when it is none. */
function jsonOf(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1];
  try {
    return JSON.parse((fenced ?? text).trim());
  } catch {
    // none: never the parser's message, it quotes the model's text
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A model's answer that is not usable: only what is structural — which region, what is wrong with it —
 * never a word the model wrote, which can be the personal data being redacted.
 */
export class RegionsAnswerError extends Error {
  override name = "RegionsAnswerError";
}

/**
 * The regions of the model's answer, each held to the rules: any one that breaks them fails the
 * redaction, and so does a list longer than `maxRegions` (#1257: the model is no bound of the work).
 * A region whose target is none asked for is kept as `UNKNOWN_TARGET` — painted, never refused,
 * since painting removes the pixels — and `onUnknown` hears how many there were (#1301).
 */
export function regionsOf(
  text: string,
  known: ReadonlySet<string>,
  maxRegions: number = MAX_REGIONS,
  onUnknown?: (count: number) => void,
): readonly Region[] {
  const answer = jsonOf(text);
  const list = isRecord(answer) ? answer.regions : undefined;
  if (!Array.isArray(list)) throw new RegionsAnswerError("the answer has no regions list");
  if (list.length > maxRegions)
    throw new RegionsAnswerError(
      `the answer has ${String(list.length)} regions, more than the ${String(maxRegions)} taken`,
    );
  let unknown = 0;
  const regions = list.map((entry: unknown, index): Region => {
    const at = `region ${String(index + 1)} of ${String(list.length)}`;
    if (!isRecord(entry)) throw new RegionsAnswerError(`${at} is no object`);
    const { target, x, y, w, h } = entry;
    // the known target that is the answer's, so no text check beside the set's
    const named = [...known].find((candidate) => candidate === target) ?? UNKNOWN_TARGET;
    if (named === UNKNOWN_TARGET) unknown += 1;
    if (
      !isFraction(x, 0, 0.999999, false) ||
      !isFraction(y, 0, 0.999999, false) ||
      !isFraction(w, 0, 1, true) ||
      !isFraction(h, 0, 1, true)
    )
      throw new RegionsAnswerError(`${at} is out of bounds`);
    return { target: named, x: x as number, y: y as number, w: w as number, h: h as number };
  });
  if (unknown > 0) onUnknown?.(unknown);
  return regions;
}

/** The pixel box of a region: padded, clamped to the image. */
export function boxOf(
  region: Region,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const padX = Math.max(
    region.w * PADDING_X,
    Math.min(region.h * MIN_PADDING_X_OF_HEIGHT, MAX_MIN_PADDING_X),
  );
  const padY = Math.min(region.h * PADDING_Y, MAX_PADDING_Y);
  const left = Math.max(0, Math.floor((region.x - padX) * width));
  const top = Math.max(0, Math.floor((region.y - padY) * height));
  const right = Math.min(width, Math.ceil((region.x + region.w + padX) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.h + padY) * height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
