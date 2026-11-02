import type { RagSearchResultDto } from "../dto/standard/framework.js";

/** What a knowledge base found for a query: its search results (each cited as `[source]`). */
export interface RagRetrieval {
  readonly results: readonly RagSearchResultDto[];
  /** What this retrieval cost (embeddings, a search API); 0 or absent when free. */
  readonly costUsd?: number;
}

export interface IndexReport {
  readonly documents: number;
  readonly chunks: number;
  /** Documents left as they were (unchanged since the last index). */
  readonly skipped: number;
  readonly costUsd?: number;
}

/**
 * The contract of a knowledge base. Implement it with any embeddings and storage; the core does the
 * wiring (tool or context), cost reporting and tracing, and passes the execution's tenant on every
 * call (#700) — a connector returns and indexes that tenant's passages only
 * (`ragConnectorContract`, `@agboss/core/testing/contracts`, proves it).
 */
export interface RagConnector {
  /** The tenant's top-k search results for `query` (#700: never another tenant's). */
  readonly retrieve: (query: string, options: RagRetrieveOptions) => Promise<RagRetrieval>;
  /** Optional: build or update one tenant's index (`agboss rag index --tenant <id>`). */
  readonly index?: (options: RagIndexOptions) => Promise<IndexReport>;
}

/** What one retrieval is asked for. */
export interface RagRetrieveOptions {
  readonly topK: number;
  readonly signal: AbortSignal;
  /**
   * The execution's tenant (#700): return only its passages. A key's text (#552) — compare it as
   * given (no case, width or accent folding): `acme` and `Acme` are two tenants.
   */
  readonly tenantId: string;
}

/** What one index build is asked for (#700). */
export interface RagIndexOptions {
  /** The tenant whose knowledge base to build or update: index into it only. */
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

/** A retrieval as the core asks it: the tenant is the execution's, supplied by the core (#700). */
export type KnowledgeRetrieve = (
  query: string,
  options: { readonly topK: number; readonly signal: AbortSignal },
) => Promise<RagRetrieval>;

/** A knowledge base as the core runs it in context mode (retrieved before the agent's loop). */
export interface KnowledgeSource {
  readonly name: string;
  readonly topK: number;
  readonly retrieve: KnowledgeRetrieve;
}

/** How an agent gets a knowledge base's results (#269): it searches itself, or they come first. */
export enum RagMode {
  /** The agent calls `search-<name>-tool` itself. */
  Tool = "tool",
  /** The results come with the agent's input message, before its first model call. */
  Context = "context",
}
