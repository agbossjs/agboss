import { totalCost, type UsageRecord } from "../finops/usage.js";
import { reportFrameEvent } from "../flow/observers/execution-event.js";
import { RerankOutcome } from "../flow/observers/rerank.js";
import type { KnowledgeRetrieval } from "./types.js";

/**
 * A reranking between `onRerankStart` and `onRerankEnd` (#1299, #1343): told to the observers of the
 * execution whose step (or tool call) retrieves, masked by its workflow's policies. The end is told
 * for every start — a reranking that fails the step too, with what its failed model call spent.
 */

/** What is reranked: whose reranker, how many candidates, how many to keep. */
interface RerankAbout {
  readonly candidates: number;
  readonly topK: number;
}

/** The names a reranking is told under. */
interface RerankNames {
  readonly rag: string;
  readonly reranker: string;
}

/** The spend a failed reranking carries (`RerankFailedError.usage`); none for any other error. */
function spentByFailure(error: unknown): readonly UsageRecord[] {
  const usage: unknown = error instanceof Error ? Reflect.get(error, "usage") : undefined;
  return Array.isArray(usage) ? (usage as readonly UsageRecord[]) : [];
}

/** `rerank` between the two events. */
export async function observedRerank(
  names: RerankNames,
  about: RerankAbout,
  rerank: () => Promise<{
    readonly retrieval: KnowledgeRetrieval;
    readonly outcome: RerankOutcome;
  }>,
): Promise<KnowledgeRetrieval> {
  const { rag, reranker } = names;
  const started = { rag, reranker, ...about };
  await reportFrameEvent((observer, base) => observer.onRerankStart({ ...base, ...started }));
  try {
    const { retrieval, outcome } = await rerank();
    await reportFrameEvent((observer, base) =>
      observer.onRerankEnd({
        ...base,
        ...started,
        outcome,
        results: retrieval.results.length,
        costUsd: totalCost(retrieval.usage ?? []),
      }),
    );
    return retrieval;
  } catch (error) {
    await reportFrameEvent((observer, base) =>
      observer.onRerankEnd({
        ...base,
        ...started,
        outcome: RerankOutcome.Failed,
        results: 0,
        costUsd: totalCost(spentByFailure(error)),
      }),
    );
    throw error;
  }
}
