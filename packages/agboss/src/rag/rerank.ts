import { RunnableLambda } from "@langchain/core/runnables";
import type { RagSearchResultDto } from "../dto/standard/framework.js";
import { recordReportedCost, type UsageRecord } from "../finops/usage.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import type { ModelBinding } from "../llm/registry.js";
import { MODEL_RERANKER_USAGE, modelRerankerOf, RerankReplyError } from "./llm-reranker.js";
import {
  RERANK_FAILED_CODE,
  RerankFailurePolicy,
  type KnowledgeRetrieval,
  type RagReranking,
  type RagRetrieval,
  type RerankerHandler,
} from "./types.js";

/**
 * Reranking (#703, loaded on its first use): a knowledge base's `candidates`, re-ordered by its
 * `@Reranker`, its best `keep` to the agent — one span `rerank:<rag>`, the reranker's spend under
 * `rag:<rag>`. What comes back is a subset of the tenant's own candidates, or a failure: a reranker
 * can never put a passage the retrieval did not return in front of the agent.
 */

/** Where a reranker's handler comes from: the container (code) or the model gateway (model). */
export type RerankerSource =
  | { readonly kind: "code"; readonly instance: () => RerankerHandler }
  | { readonly kind: "model"; readonly binding: () => ModelBinding };

/** A knowledge base's reranker as the core runs it. */
export interface BoundReranker {
  /** The knowledge base's name: its spans and its cost caller. */
  readonly rag: string;
  /** The `@Reranker`'s name. */
  readonly reranker: string;
  readonly candidates: number;
  readonly onFailure: RerankFailurePolicy;
  readonly source: RerankerSource;
}

/** A reranking that failed under `RerankFailurePolicy.FailStep`: the agent's step fails. */
export class RerankFailedError extends StepFailedError {
  static override readonly code: string = RERANK_FAILED_CODE;
  override name = "RerankFailedError";
  /** The knowledge base whose reranking failed. */
  readonly rag: string;
  /** Its `@Reranker`, by name. */
  readonly reranker: string;

  constructor(bound: BoundReranker, cause: unknown, usage: readonly UsageRecord[]) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `Knowledge base "${bound.rag}": its reranker ${bound.reranker} failed (${why}) — RerankFailurePolicy.FailStep fails the step`,
      usage,
      cause,
      stepCoordinatesOf(bound.rag, ComponentKind.Rag),
      { rag: bound.rag, reranker: bound.reranker },
    );
    this.rag = bound.rag;
    this.reranker = bound.reranker;
  }
}

/** A reranking that is not a subset of the candidates, or longer than `keep`. */
class InvalidRerankingError extends Error {
  override name = "InvalidRerankingError";
}

const keyOf = (result: RagSearchResultDto): string => `${result.source}\u0000${result.text}`;

/** The reranking's results, once each is one of the candidates, none twice, at most `keep`. */
function checkedResults(
  candidates: readonly RagSearchResultDto[],
  reranking: RagReranking,
  keep: number,
): readonly RagSearchResultDto[] {
  const known = new Set(candidates.map(keyOf));
  const seen = new Set<string>();
  if (reranking.results.length > keep)
    throw new InvalidRerankingError(
      `it returned ${String(reranking.results.length)} > keep ${String(keep)}`,
    );
  for (const result of reranking.results) {
    const key = keyOf(result);
    if (!known.has(key))
      throw new InvalidRerankingError("it returned a passage that is no candidate");
    if (seen.has(key)) throw new InvalidRerankingError("it returned one candidate twice");
    seen.add(key);
  }
  return reranking.results;
}

/** The reranker's spend: a model reranker's call, or a code reranker's reported cost. */
function spendOf(bound: BoundReranker, reranking: RagReranking): readonly UsageRecord[] {
  const caller = `rag:${bound.rag}`;
  const usage = (reranking as { [MODEL_RERANKER_USAGE]?: readonly UsageRecord[] })[
    MODEL_RERANKER_USAGE
  ];
  if (usage !== undefined) return usage.map((record) => ({ ...record, caller }));
  const cost = reranking.costUsd ?? 0;
  return cost === 0 ? [] : [recordReportedCost({ name: bound.reranker, costCaller: caller }, cost)];
}

/** The spend a failed reranking still made (a model's reply it could not read). */
const failedSpendOf = (bound: BoundReranker, error: unknown): readonly UsageRecord[] =>
  error instanceof RerankReplyError
    ? error.usage.map((record) => ({ ...record, caller: `rag:${bound.rag}` }))
    : [];

const handlerOf = (bound: BoundReranker): RerankerHandler =>
  bound.source.kind === "code"
    ? bound.source.instance()
    : modelRerankerOf(bound.reranker, bound.source.binding());

/** One reranking call. */
export interface RerankCall {
  readonly query: string;
  readonly keep: number;
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

/**
 * The tenant's `candidates` from `retrieve`, reranked, its best `keep`: on a failure the retrieval's
 * own first `keep` with a `rerank:<rag>:fallback` span, or `RerankFailedError` under `FailStep`. An
 * aborted call stays aborted (it is no reranker's failure); an empty retrieval calls no reranker.
 */
export async function rerankedRetrieval(
  retrieve: (topK: number) => Promise<RagRetrieval>,
  bound: BoundReranker,
  call: RerankCall,
): Promise<KnowledgeRetrieval> {
  const fetched = await retrieve(Math.max(bound.candidates, call.keep));
  if (fetched.results.length === 0) return fetched;
  const { query, keep, tenantId, signal } = call;
  const sources = fetched.results.map((result) => result.source);
  try {
    const reranked = await RunnableLambda.from(async () => {
      const reranking = await handlerOf(bound).rerank(query, fetched.results, {
        keep,
        signal,
        tenantId,
      });
      return {
        results: checkedResults(fetched.results, reranking, keep),
        usage: spendOf(bound, reranking),
      };
    }).invoke({ query, candidates: sources }, { runName: `rerank:${bound.rag}` });
    return { results: reranked.results, costUsd: fetched.costUsd, usage: reranked.usage };
  } catch (error) {
    if (signal.aborted) throw error;
    const usage = failedSpendOf(bound, error);
    if (bound.onFailure === RerankFailurePolicy.FailStep)
      throw new RerankFailedError(bound, error, usage);
    const reason = error instanceof Error ? error.message : String(error);
    await RunnableLambda.from((fallback: { readonly reason: string }) => fallback).invoke(
      { reason },
      { runName: `rerank:${bound.rag}:fallback` },
    );
    return { results: fetched.results.slice(0, keep), costUsd: fetched.costUsd, usage };
  }
}
