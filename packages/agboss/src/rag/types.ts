import { type Usd } from "../units/index.js";
import type { UsageRecord } from "../finops/usage.js";
import type { RagSearchResultDto } from "./dto.js";

/** What a knowledge base found for a query: its search results (each cited as `[source]`). */
export interface RagRetrieval {
  readonly results: readonly RagSearchResultDto[];
  /** What this retrieval cost (embeddings, a search API); 0 or absent when free. */
  readonly costUsd?: Usd;
  /** The tokens an embedding model read for it: they count toward `@Budget({ maxTokens })`. */
  readonly tokens?: number;
}

/** What one index build did (`agboss rag index` prints it). */
export interface RagIndexReport {
  readonly documents: number;
  readonly chunks: number;
  /** Documents left as they were (unchanged since the last index). */
  readonly skipped: number;
  readonly costUsd?: Usd;
  /** The tokens an embedding model read while indexing. */
  readonly tokens?: number;
}

/**
 * Whose content a knowledge base serves: declared on every `@Rag`, so that content many readers
 * share is a reviewed choice — never a source that forgot its tenant. The core resolves the scope's
 * id on every call and passes it as `scopeId`; `describe` prints the choice and `configHash` covers it.
 */
export enum RagScope {
  /** One corpus every tenant may read (a public help center): no `scopeId`. */
  Shared = "shared",
  /** Each tenant's own passages: `scopeId` is the execution's tenant id. */
  Tenant = "tenant",
  /** Each owner's own passages: `scopeId` is the execution's owner (`CallOptions.owner`). */
  Owner = "owner",
  /** Whatever `resolveScope(context)` of the source returns (an org and a department, …). */
  Custom = "custom",
}

/**
 * The key of a non-global scope: the execution's tenant AND the scope's id — an owner id or a custom
 * key is unique within a tenant only, so a source keys its rows on the pair (never on `scopeId`
 * alone, never on a concatenation: compare both parts as given). A `RagScope.Shared` call has
 * neither: it is the one declared global scope.
 */
export interface RagScopeKey {
  /** The execution's tenant: `undefined` only for `RagScope.Shared`. */
  readonly tenantId?: string;
  /** The scope's id within the tenant (the tenant's own id for `RagScope.Tenant`); `undefined` for `Shared`. */
  readonly scopeId?: string;
  /** The `@Rag`'s declared scope: set by the core and the CLI; a source never needs to set it. */
  readonly scope?: RagScope;
}

/** What one retrieval is asked for. */
export interface RagRetrieveOptions<TFilter = never> {
  /** How many results: the reranker's `candidates` when one is wired, else the call's or `@Rag`'s `topK`. */
  readonly topK: number;
  readonly signal: AbortSignal;
  /**
   * The scope's key (`tenantId` and `scopeId`, key's texts: compare each as given, no case, width
   * or accent folding): both `undefined` for `RagScope.Shared`. Return only the passages of this
   * scope, of this tenant: an owner id is unique within a tenant only.
   */
  readonly tenantId?: string;
  readonly scopeId?: string;
  /** The `@Rag`'s declared scope (`Shared` when `tenantId` and `scopeId` are both `undefined`). */
  readonly scope?: RagScope;
  /** What `search(query, { filter })` was called with. */
  readonly filter?: TFilter;
}

/** What one index build is asked for. */
export interface RagIndexOptions {
  /** The scope (its tenant and its id) to build or update: index into it only; none for `RagScope.Shared`. */
  readonly tenantId?: string;
  readonly scopeId?: string;
  /** The `@Rag`'s declared scope (`Shared` when `tenantId` and `scopeId` are both `undefined`). */
  readonly scope?: RagScope;
  readonly signal: AbortSignal;
}

/** What `RagSource.search` takes besides the query. */
export interface RagSearchOptions<TFilter = never> {
  /** Results for this call; default `@Rag({ topK })`. */
  readonly topK?: number;
  /** A filter the source understands (a vector database's metadata filter). */
  readonly filter?: TFilter;
}

/** A retrieval the core ran: the source's, and the reranker's model calls when it reranked. */
export interface KnowledgeRetrieval extends RagRetrieval {
  /** The reranker's spend, under `rag:<name>`: counted by the budgets like a retrieval's. */
  readonly usage?: readonly UsageRecord[];
}

/** A retrieval as the core asks it: the scope is the execution's, supplied by the core. */
export type KnowledgeRetrieve = (
  query: string,
  options: { readonly topK: number; readonly signal: AbortSignal; readonly filter?: unknown },
) => Promise<KnowledgeRetrieval>;

/** What one reranking is asked for. */
export interface RerankOptions {
  /** At most this many results, best first: the knowledge base's `topK`. */
  readonly topK: number;
  readonly signal: AbortSignal;
  /** The scope's id of the retrieval: the candidates are its own. */
  readonly tenantId?: string;
  readonly scopeId?: string;
}

/** A reranker's answer: some of the candidates, best first, with its own scores. */
export interface RerankResult {
  /** A subset of the candidates as given — never a passage of its own, at most `topK`. */
  readonly results: readonly RagSearchResultDto[];
  /** What this reranking cost (a rerank API); 0 or absent when free. */
  readonly costUsd?: Usd;
  /** The tokens it read, when it is a model. */
  readonly tokens?: number;
}

/**
 * The contract of a code reranker: `rerank()` on a `@RagReranker` class — a dedicated API (Cohere
 * Rerank, …) on its official SDK, or your own code. No `implements` needed.
 */
export interface RerankerHandler {
  readonly rerank: (
    query: string,
    candidates: readonly RagSearchResultDto[],
    options: RerankOptions,
  ) => RerankResult | Promise<RerankResult>;
}

/** What a knowledge base does when its reranker fails: the default is `FailStep`. */
export enum RerankFailurePolicy {
  /** `step.rerank-failed` fails the agent's step (the default). */
  FailStep = "fail-step",
  /** The retrieval's own first `topK` results, a `rerank:<name>:fallback` span in the trace. */
  Fallback = "fallback",
}

/** The code of a reranking that failed under `RerankFailurePolicy.FailStep`. */
export const RERANK_FAILED_CODE = "step.rerank-failed";

/** A knowledge base as the core runs it in context mode (retrieved before the agent's loop). */
export interface KnowledgeSource {
  readonly name: string;
  readonly topK: number;
  readonly retrieve: KnowledgeRetrieve;
}
