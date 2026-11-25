import type { EarlierShare } from "../models/transport/stream-partial.js";
/**
 * What a fallback call leaves in the response's `usage` (#202): the model that served it and
 * whether its cost came from the fallback's price table. The cost record reads it, so the call is
 * accounted under the fallback's model and prices — never the primary's.
 */
export interface FallbackMark {
  /** The provider that served the call (its `name`): the record carries it, never the primary's. */
  readonly provider: string | undefined;
  /** What the providers before it spent on the call before they failed (#1399). */
  readonly earlier: readonly EarlierShare[];
  readonly model: string;
  readonly priced: boolean;
  /** The fallback provider has no `cost` (#1313): a call it leaves unpriced is recorded `CostSource.Unpriced`. */
  readonly unpriced: boolean;
}

/** The key of the mark in the response's `usage`. */
export const FALLBACK_MARK = "agboss_fallback";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fallback mark of a model message (`response_metadata.usage`), when a fallback served it. */
export function fallbackMarkOf(
  metadata: Readonly<Record<string, unknown>> | undefined,
): FallbackMark | undefined {
  const usage = metadata?.usage;
  const mark = isRecord(usage) ? usage[FALLBACK_MARK] : undefined;
  if (!isRecord(mark) || typeof mark.model !== "string") return undefined;
  return {
    provider: typeof mark.provider === "string" ? mark.provider : undefined,
    earlier: Array.isArray(mark.earlier) ? (mark.earlier as readonly EarlierShare[]) : [],
    model: mark.model,
    priced: mark.priced === true,
    unpriced: mark.unpriced === true,
  };
}
