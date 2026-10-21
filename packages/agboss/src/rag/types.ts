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
 * wiring (tool or context), cost reporting and tracing.
 */
export interface RagConnector {
  readonly retrieve: (
    query: string,
    options: { readonly topK: number; readonly signal: AbortSignal },
  ) => Promise<RagRetrieval>;
  /** Optional: build or update the index (`npm run rag:index`). */
  readonly index?: () => Promise<IndexReport>;
}

/** A knowledge base as the core runs it in context mode (retrieved before the agent's loop). */
export interface KnowledgeSource {
  readonly name: string;
  readonly topK: number;
  readonly retrieve: RagConnector["retrieve"];
}

/** How an agent gets a knowledge base's results (#269): it searches itself, or they come first. */
export enum RagMode {
  /** The agent calls `search-<name>-tool` itself. */
  Tool = "tool",
  /** The results come with the agent's input message, before its first model call. */
  Context = "context",
}
