import { CardCache } from "./a2a-card-cache.js";
import { mergedHeaders, type ResolvedAgent } from "./a2a-agent-config.js";
import type { A2AClientContract, A2AClientOptions } from "./a2a-client-options.js";
import { originPolicyOf } from "./a2a-origins.js";

/** What a client's card cache is built from (#1320): its address as resolved, its options, its dynamic headers. */
export interface ClientCacheSources {
  readonly agent: string;
  readonly contract: A2AClientContract | undefined;
  readonly resolved: ResolvedAgent;
  readonly options: A2AClientOptions;
  /** The subclass's `getHeaders()`, asked per request. */
  readonly dynamicHeaders: () => Promise<Record<string, string>>;
}

/**
 * The client's card cache: on its address's origins, its headers merged without regard to case — the
 * declared ones, then the `headers` option's, then `getHeaders()`'s.
 */
export function cardCacheOf(sources: ClientCacheSources): CardCache {
  const { agent, contract, resolved, options } = sources;
  return new CardCache({
    url: resolved.url,
    agent,
    contract,
    policy: originPolicyOf(agent, resolved.url, resolved.allowedOrigins),
    fetcher: options.fetcher ?? fetch,
    headersOf: async () =>
      mergedHeaders(resolved.headers, options.headers ?? {}, await sources.dynamicHeaders()),
    ttl: options.cardTtl,
  });
}
