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
 * The caching of a provider that sets none (#1313): the system prompt, the tools and the history at
 * `FiveMinutes`, wherever the model supports it — and silently none where it does not, unlike an
 * explicit `PromptCaching`, which the startup check refuses on a model that cannot honour it. A
 * singleton, told apart by identity (`isAutoCaching`); to a transport it is its defaults.
 */
export const AUTO_PROMPT_CACHING: PromptCaching = Object.freeze({
  kind: "where-supported",
  retention: CacheRetention.FiveMinutes,
  cachedParts: Object.freeze([CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History]),
});

/** Whether `caching` is the provider's default (see `AUTO_PROMPT_CACHING`), not a setting made on purpose. */
export const isAutoCaching = (caching: PromptCaching): boolean => caching === AUTO_PROMPT_CACHING;

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
  if (caching.kind === "off") return "off";
  if (isAutoCaching(caching)) return "auto (system prompt, tools, history; 5m, where supported)";
  return `where supported (${caching.retention}; ${caching.cachedParts.join(", ")})`;
}
