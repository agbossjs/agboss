import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";
/** How long a cached prompt prefix lives. */
export enum CacheRetention {
  FiveMinutes = "5m",
  OneHour = "1h",
  OneDay = "24h",
}

/** The parts of a request that are cached: the stable prefix and the history before the new turn. */
export enum CachedPart {
  SystemPrompt = "system-prompt",
  Tools = "tools",
  History = "history",
}

/** `PromptCaching.whereSupported({ … })`. */
export interface PromptCachingOptions {
  readonly retention: CacheRetention;
  readonly cachedParts: readonly CachedPart[];
  /** A cache key, for providers that route by one (OpenAI `prompt_cache_key`). */
  readonly key?: string;
}

/** Whether prompts are cached: where the model supports it (with these settings), or off. */
export type PromptCaching =
  ({ readonly kind: "where-supported" } & PromptCachingOptions) | { readonly kind: "off" };

/**
 * A value out of range, as the platform's `RangeError`, so `catch` keeps telling it from other errors;
 * made as every framework error is (#906): `{ message, cause }`, with a literal `code`.
 */
export class PromptCachingError extends RangeError {
  static readonly code = "config.prompt-caching" as const;
  readonly code = PromptCachingError.code;
  override name = "PromptCachingError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

export const PromptCaching = {
  whereSupported(options: PromptCachingOptions): PromptCaching {
    if (options.cachedParts.length === 0) {
      throw new PromptCachingError({
        message: "cachedParts needs at least one part (or use PromptCaching.off())",
      });
    }
    return Object.freeze({ kind: "where-supported", ...options });
  },
  off(): PromptCaching {
    return Object.freeze({ kind: "off" });
  },
};

/** Today's component `cache` (until #152): true = the provider's (unset), false = off. */
export function promptCachingOfSetting(
  cache: boolean | PromptCaching | undefined,
): PromptCaching | undefined {
  if (cache === undefined || cache === true) return undefined;
  return cache === false ? PromptCaching.off() : cache;
}

export function promptCachingLabel(caching: PromptCaching): string {
  return caching.kind === "off"
    ? "off"
    : `where supported (${caching.retention}; ${caching.cachedParts.join(", ")})`;
}
