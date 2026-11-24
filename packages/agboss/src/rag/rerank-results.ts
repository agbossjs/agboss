import { copyOfResult, type RagSearchResultDto } from "./dto.js";
import type { RerankResult } from "./types.js";

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
export function checkedResults(
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
