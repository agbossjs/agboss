import type { RagSearchResultDto } from "../dto/standard/framework.js";
import type { UsageRecord } from "../finops/usage.js";

/** What a knowledge base found for a query: its search results (each cited as `[source]`). */
export interface RagRetrieval {
  readonly results: readonly RagSearchResultDto[];
  /** What this retrieval cost (embeddings, a search API); 0 or absent when free. */
  readonly costUsd?: number;
}

/** What one index build did (`agboss rag index` prints it). */
export interface RagIndexReport {
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
  readonly index?: (options: RagIndexOptions) => Promise<RagIndexReport>;
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

/** A retrieval the core ran: the connector's, and the reranker's model calls when it reranked (#703). */
export interface KnowledgeRetrieval extends RagRetrieval {
  /** The reranker's spend (#703), under `rag:<name>`: counted by the budgets like a retrieval's. */
  readonly usage?: readonly UsageRecord[];
}

/** A retrieval as the core asks it: the tenant is the execution's, supplied by the core (#700). */
export type KnowledgeRetrieve = (
  query: string,
  options: { readonly topK: number; readonly signal: AbortSignal },
) => Promise<KnowledgeRetrieval>;

/** What one reranking is asked for (#703). */
export interface RerankOptions {
  /** At most this many results, best first: the knowledge base's `rerank.topK`. */
  readonly topK: number;
  readonly signal: AbortSignal;
  /** The execution's tenant (#700): the candidates are its own. */
  readonly tenantId: string;
}

/** A reranker's answer (#703): some of the candidates, best first, with its own scores. */
export interface RerankResult {
  /** A subset of the candidates as given — never a passage of its own, at most `topK`. */
  readonly results: readonly RagSearchResultDto[];
  /** What this reranking cost (a rerank API); 0 or absent when free. */
  readonly costUsd?: number;
}

/**
 * The contract of a reranker (#703): `@Reranker({ decidedBy: DecidedBy.Code })` + `implements
 * RerankerHandler` — a dedicated API (Cohere Rerank, …) on its official SDK, or your own code.
 */
export interface RerankerHandler {
  readonly rerank: (
    query: string,
    candidates: readonly RagSearchResultDto[],
    options: RerankOptions,
  ) => Promise<RerankResult>;
}

/** What a knowledge base does when its reranker fails (#703): the default is `Fallback`. */
export enum RerankFailurePolicy {
  /** The retrieval's own first `topK` results, a `rerank:<name>:fallback` span in the trace. */
  Fallback = "fallback",
  /** `RerankFailedError` (`step.rerank-failed`, a `StepFailedError`) fails the agent's step. */
  FailStep = "fail-step",
}

/**
 * The model of a model `@Reranker` without its own (#703): cheap, non-reasoning, served by the
 * built-in OpenRouter; `[model.unserved]` names `rerankers.<name>` under providers that do not.
 */
export const DEFAULT_RERANKER_MODEL = "openai/gpt-4.1-nano";

/** The code of a reranking that failed under `RerankFailurePolicy.FailStep` (#703). */
export const RERANK_FAILED_CODE = "step.rerank-failed";

declare const modelRerankerBrand: unique symbol;

/**
 * The base of a model `@Reranker` (#703): `class DocsReranker extends ModelReranker {}` — the core's
 * LLM reranker does the work, so the class has no code; extending this makes it a reranker class
 * that `rerank.by` accepts (an empty class of another kind does not compile there).
 */
export abstract class ModelReranker {
  declare private readonly [modelRerankerBrand]: "model-reranker";
}

/**
 * A `@Reranker` class, as `rerank.by` takes it: a code one (`implements RerankerHandler`) or a model
 * one (`extends ModelReranker`). Any other class — an agent, a plain or empty class — does not
 * compile; a JS caller's is `[rag.not-a-reranker]` at assembly.
 */
export type RerankerClass = abstract new (...args: never[]) => RerankerHandler | ModelReranker;

/** `@Rag({ rerank })` (#703): fetch `candidates`, rerank them with `by`, give the agent `topK`. */
export interface RagRerank {
  /** A `@Reranker` class: the LLM reranker (`DecidedBy.Model`) or your own (`DecidedBy.Code`). */
  readonly by: RerankerClass;
  /** How many results the connector is asked for. */
  readonly candidates: number;
  /** How many reach the agent, best first (`1 ≤ topK ≤ candidates`) — as `@Rag({ topK })` without reranking. */
  readonly topK: number;
  /** Default `RerankFailurePolicy.Fallback`. */
  readonly onFailure?: RerankFailurePolicy;
}

/**
 * Whose content a knowledge base serves (#796): declared on every `@Rag`, so that content every
 * tenant reads is a reviewed choice — never a connector that forgot the tenant. The core passes the
 * execution's tenant either way (#700); `describe` prints the choice and `configHash` covers it.
 */
export enum RagTenancy {
  /** Each tenant's own passages: `retrieve` and `index` read `tenantId` (`ragConnectorContract` proves it). */
  PerTenant = "per-tenant",
  /** One corpus every tenant may read (a public help center): the connector may ignore `tenantId`. */
  Shared = "shared",
}

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
