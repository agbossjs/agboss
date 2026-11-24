import { RunnableLambda } from "@langchain/core/runnables";
import { copyOfResult, type RagSearchResultDto } from "./dto.js";
import { recordReportedCost, type UsageRecord } from "../finops/usage.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import type { ModelBinding } from "../llm/registry.js";
import {
  MODEL_RERANKER_USAGE,
  modelRerankerOf,
  RerankReplyError,
  type RerankReading,
} from "./llm-reranker.js";
import { modelReadingNow } from "../pii/model-boundary.js";
import {
  RERANK_FAILED_CODE,
  RerankFailurePolicy,
  type KnowledgeRetrieval,
  type RagRetrieval,
  type RerankerHandler,
  type RerankResult,
} from "./types.js";

/**
 * Reranking (loaded on its first use): a knowledge base's `candidates`, re-ordered by its
 * `@RagReranker`, its best `topK` to the agent — one span `rerank:<rag>`, the reranker's spend under
 * `reranker:<name>` (the rag category). What comes back is a subset of the scope's own candidates,
 * or a failure: a reranker can never put a passage the retrieval did not return in front of the agent.
 */

/** Where a reranker's handler comes from: the container (code) or the model gateway (model). */
export type RerankerSource =
  | { readonly kind: "code"; readonly instance: () => RerankerHandler }
  | { readonly kind: "model"; readonly binding: () => ModelBinding };

/** A knowledge base's reranker as the core runs it. */
export interface BoundReranker {
  /** The knowledge base's name: its spans and its cost caller. */
  readonly rag: string;
  /** The `@RagReranker`'s name. */
  readonly reranker: string;
  readonly candidates: number;
  /** A model reranker reads a candidate's first this many characters (default 1200). */
  readonly maxCandidateLength?: number | undefined;
  readonly onFailure: RerankFailurePolicy;
  readonly source: RerankerSource;
}

/** What a failed reranking was: `new RerankFailedError({ rag, reranker, cause, usage })`. */
export interface RerankFailedErrorOptions {
  /** The knowledge base whose reranking failed. */
  readonly rag: string;
  /** Its `@RagReranker`, by name. */
  readonly reranker: string;
  /** What the reranker threw, or why its answer was refused. */
  readonly cause?: unknown;
  /** The spend the failed reranking still made (a model's reply it could not read). */
  readonly usage: readonly UsageRecord[];
}

/** A reranking that failed under `RerankFailurePolicy.FailStep`, the default: the agent's step fails. */
export class RerankFailedError extends StepFailedError {
  static override readonly code = RERANK_FAILED_CODE;
  declare readonly code: "step.rerank-failed";
  override name = "RerankFailedError";
  /** The knowledge base whose reranking failed. */
  readonly rag: string;
  /** Its `@RagReranker`, by name. */
  readonly reranker: string;

  constructor({ rag, reranker, cause, usage }: RerankFailedErrorOptions) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super({
      message: `Knowledge base "${rag}": its reranker ${reranker} failed (${why}) — RerankFailurePolicy.FailStep fails the step`,
      usage,
      cause,
      ...stepCoordinatesOf(rag, ComponentKind.Rag),
      details: { rag, reranker },
    });
    this.rag = rag;
    this.reranker = reranker;
  }
}

/** A reranking that is not a subset of the candidates, or longer than `topK`. */
class InvalidRerankingError extends Error {
  override name = "InvalidRerankingError";
}

/** A candidate's identity: its `id` when it has one, else its source and text (two chunks of one document may share a text). */
const keyOf = (result: RagSearchResultDto): string =>
  result.id === undefined
    ? `${result.source}\u0000${result.text}`
    : `id\u0000${result.id}\u0000${result.source}`;

/**
 * The reranking's results: each is one of the candidates, none twice, at most `topK`. What comes
 * back is the CANDIDATE itself, found by key — the reranker contributes its order and its score
 * only, never a text or a field: a model-backed reranker is untrusted, and what it returns must
 * not reach the agent's context rewritten.
 */
function checkedResults(
  candidates: readonly RagSearchResultDto[],
  reranking: RerankResult,
  topK: number,
): readonly RagSearchResultDto[] {
  const known = new Map(candidates.map((candidate) => [keyOf(candidate), candidate] as const));
  const seen = new Set<string>();
  if (reranking.results.length > topK)
    throw new InvalidRerankingError(
      `it returned ${String(reranking.results.length)} > topK ${String(topK)}`,
    );
  return reranking.results.map((result) => {
    const key = keyOf(result);
    const candidate = known.get(key);
    if (candidate === undefined)
      throw new InvalidRerankingError("it returned a passage that is no candidate");
    if (seen.has(key)) throw new InvalidRerankingError("it returned one candidate twice");
    seen.add(key);
    return typeof result.score === "number" && Number.isFinite(result.score)
      ? copyOfResult(candidate, { score: result.score })
      : candidate;
  });
}

/**
 * The reranker's spend: a model reranker's call (caller `reranker:<name>`), or a code reranker's
 * reported cost and tokens under the same caller.
 */
function spendOf(bound: BoundReranker, reranking: RerankResult): readonly UsageRecord[] {
  const usage = (reranking as { [MODEL_RERANKER_USAGE]?: readonly UsageRecord[] })[
    MODEL_RERANKER_USAGE
  ];
  if (usage !== undefined) return usage;
  const cost = reranking.costUsd ?? 0;
  const tokens = reranking.tokens ?? 0;
  if (cost === 0 && tokens === 0) return [];
  const caller = `reranker:${bound.reranker}`;
  return [
    {
      ...recordReportedCost({ name: bound.reranker, costCaller: caller }, cost),
      inputTokens: tokens,
    },
  ];
}

/** The spend a failed reranking still made (a model's reply it could not read). */
const failedSpendOf = (error: unknown): readonly UsageRecord[] =>
  error instanceof RerankReplyError ? error.usage : [];

const handlerOf = (bound: BoundReranker, reading: RerankReading | undefined): RerankerHandler =>
  bound.source.kind === "code"
    ? bound.source.instance()
    : modelRerankerOf(bound.reranker, bound.source.binding(), reading, bound.maxCandidateLength);

/** What a model reranker's model reads and what masking it cost (#708). */
interface MaskedRerank {
  readonly reading?: RerankReading;
  readonly usage: readonly UsageRecord[];
}

/**
 * The query and the candidates as the core's model reranker reads them (#708): through the reading
 * agent's PII policies — a block rule in them refuses here, before any model reads them, as the
 * agent's boundary refuses the same passages; a code reranker's call is the project's own.
 */
async function maskedRerankOf(
  bound: BoundReranker,
  query: string,
  candidates: readonly RagSearchResultDto[],
): Promise<MaskedRerank> {
  const mask = bound.source.kind === "model" ? modelReadingNow() : undefined;
  if (mask === undefined) return { usage: [] };
  const texts = candidates.map((candidate) => candidate.text);
  const sources = candidates.map((candidate) => candidate.source);
  const masked = await mask([query, ...texts, ...sources]);
  const [maskedQuery = query, ...rest] = masked.texts;
  const reading = {
    query: maskedQuery,
    texts: rest.slice(0, texts.length),
    sources: rest.slice(texts.length),
  };
  return { reading, usage: masked.usage };
}

/** One reranking call. */
export interface RerankCall {
  readonly query: string;
  readonly topK: number;
  readonly tenantId?: string;
  readonly scopeId?: string;
  readonly signal: AbortSignal;
}

/**
 * The scope's `candidates` from `retrieve`, reranked, its best `topK`: on a failure `RerankFailedError`
 * (the default `FailStep`), or the retrieval's own first `topK` with a `rerank:<rag>:fallback` span under `Fallback`. An
 * aborted call stays aborted (it is no reranker's failure); an empty retrieval calls no reranker.
 */
export async function rerankedRetrieval(
  retrieve: (topK: number) => Promise<RagRetrieval>,
  bound: BoundReranker,
  call: RerankCall,
): Promise<KnowledgeRetrieval> {
  const fetched = await retrieve(Math.max(bound.candidates, call.topK));
  if (fetched.results.length === 0) return fetched;
  const { query, topK, tenantId, scopeId, signal } = call;
  // outside the failure policy: a block rule refuses as the agent's own boundary would (#708)
  const masked = await maskedRerankOf(bound, query, fetched.results);
  const shown = masked.reading ?? { query, sources: fetched.results.map((r) => r.source) };
  try {
    const reranked = await RunnableLambda.from(async () => {
      const reranking = await handlerOf(bound, masked.reading).rerank(query, fetched.results, {
        topK,
        signal,
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(scopeId === undefined ? {} : { scopeId }),
      });
      return {
        results: checkedResults(fetched.results, reranking, topK),
        usage: [...masked.usage, ...spendOf(bound, reranking)],
      };
    }).invoke(
      { query: shown.query, candidates: shown.sources },
      { runName: `rerank:${bound.rag}` },
    );
    return { ...fetched, results: reranked.results, usage: reranked.usage };
  } catch (error) {
    if (signal.aborted) throw error;
    const usage = [...masked.usage, ...failedSpendOf(error)];
    if (bound.onFailure === RerankFailurePolicy.FailStep)
      throw new RerankFailedError({
        rag: bound.rag,
        reranker: bound.reranker,
        cause: error,
        usage,
      });
    const reason = error instanceof Error ? error.message : String(error);
    await RunnableLambda.from((fallback: { readonly reason: string }) => fallback).invoke(
      { reason },
      { runName: `rerank:${bound.rag}:fallback` },
    );
    return { ...fetched, results: fetched.results.slice(0, topK), usage };
  }
}
