import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RagSearchResultDto } from "../dto/standard/framework.js";
import { recordUsage, type UsageRecord } from "../finops/usage.js";
import type { ModelBinding } from "../llm/registry.js";
import type { RagReranking, RerankerHandler } from "./types.js";

/**
 * The core's LLM reranker (#703): one call on the `@Reranker`'s chat model — the query and the
 * numbered candidates in, `{"ranking":[3,1,…]}` out. The model names candidates by number, never
 * rewrites one; the numbers it gives (in range, each once) come first, the rest follow in retrieval
 * order, cut to `keep` — it never loses a candidate it did not rank. A reply with no ranking is a
 * failure that still carries the call's spend.
 */

/** Where a model reranking keeps its call's spend (the core reads it, a code reranker cannot set it). */
export const MODEL_RERANKER_USAGE: unique symbol = Symbol("agboss.model-reranker-usage");

/** A candidate's text as the model reads it: at most this many characters. */
const MAX_CANDIDATE_CHARS = 1200;

export const RERANKER_SYSTEM = [
  "You rerank search results for a query.",
  'Reply with JSON only: {"ranking": [n, ...]} — the numbers of the results that best answer the query, the best first.',
  "Use only the numbers shown; leave out results that do not help.",
].join(" ");

/** The model's reply had no ranking it could read: a failure, its spend kept. */
export class RerankReplyError extends Error {
  override name = "RerankReplyError";

  constructor(
    message: string,
    readonly usage: readonly UsageRecord[],
  ) {
    super(message);
  }
}

/** What the model reads: the query, then each candidate numbered from 1. */
export function rerankPromptOf(
  query: string,
  candidates: readonly RagSearchResultDto[],
  keep: number,
): string {
  const lines = candidates.map(
    (candidate, index) =>
      `[${String(index + 1)}] (${candidate.source}) ${candidate.text.slice(0, MAX_CANDIDATE_CHARS)}`,
  );
  return `Query: ${query}\n\nAt most ${String(keep)} numbers.\n\nResults:\n${lines.join("\n")}`;
}

/** The numbers of a reply's ranking, in range and each once; `undefined` when it has none. */
export function rankingOf(reply: string, count: number): readonly number[] | undefined {
  const json = /\{[\s\S]*\}/u.exec(reply)?.[0];
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const ranking: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "ranking") : undefined;
  if (!Array.isArray(ranking)) return undefined;
  const numbers = ranking.filter(
    (n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= count,
  );
  return [...new Set(numbers)];
}

/** The candidates in the model's order, then the rest in retrieval order, `keep` of them, scored. */
export function rankedCandidates(
  candidates: readonly RagSearchResultDto[],
  ranking: readonly number[],
  keep: number,
): readonly RagSearchResultDto[] {
  const first = ranking.map((n) => n - 1);
  const rest = candidates.map((_, index) => index).filter((index) => !first.includes(index));
  const order = [...first, ...rest].slice(0, keep);
  return order.flatMap((index, position) => {
    const candidate = candidates[index];
    return candidate === undefined
      ? []
      : [
          {
            source: candidate.source,
            text: candidate.text,
            score: (order.length - position) / order.length,
          },
        ];
  });
}

/**
 * The query and the candidates' texts and sources as the model reads them (#708): masked by the reading
 * agent's policies, in that order; absent → as retrieved (no policies, or no agent).
 */
export interface RerankReading {
  readonly query: string;
  readonly texts: readonly string[];
  readonly sources: readonly string[];
}

/** The candidates the model reads: each one's text as the reading gives it. */
const readCandidates = (
  candidates: readonly RagSearchResultDto[],
  reading: RerankReading | undefined,
): readonly RagSearchResultDto[] =>
  reading === undefined
    ? candidates
    : candidates.map((candidate, index) => ({
        ...candidate,
        source: reading.sources[index] ?? candidate.source,
        text: reading.texts[index] ?? candidate.text,
      }));

/**
 * The LLM reranker of the `@Reranker` named `name`, on its bound model; its model reads `reading`
 * (#708), the ranking it gives orders the candidates as retrieved.
 */
export function modelRerankerOf(
  name: string,
  binding: ModelBinding,
  reading?: RerankReading,
): RerankerHandler {
  return {
    rerank: async (query, candidates, { keep, signal }) => {
      const read = readCandidates(candidates, reading);
      const messages = [
        new SystemMessage(RERANKER_SYSTEM),
        new HumanMessage(rerankPromptOf(reading?.query ?? query, read, keep)),
      ];
      const response = await binding.model.invoke(messages, { signal });
      const usage = [recordUsage(`reranker:${name}`, binding.settings, response)];
      const ranking = rankingOf(response.text, candidates.length);
      if (ranking === undefined)
        throw new RerankReplyError(
          `the reranker's model ${binding.settings.model} gave no ranking`,
          usage,
        );
      const reranking: RagReranking & { [MODEL_RERANKER_USAGE]: readonly UsageRecord[] } = {
        results: rankedCandidates(candidates, ranking, keep),
        [MODEL_RERANKER_USAGE]: usage,
      };
      return reranking;
    },
  };
}
