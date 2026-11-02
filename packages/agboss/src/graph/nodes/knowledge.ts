import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { recordReportedCost, type UsageRecord } from "../../finops/usage.js";
import { CITE_INSTRUCTION, knowledgeBlock } from "../../prompts/rag.js";
import {
  RERANK_FAILED_CODE,
  type KnowledgeRetrieval,
  type KnowledgeSource,
} from "../../rag/types.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import { DEFAULT_MAX_RESULT_SIZE } from "../../tools/index.js";
import type { Bytes } from "../../units/index.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/** A knowledge base's block within the agent's `maxResultSize` (#336), the marker after a cut. */
async function boundedBlock(block: string, maxResultSize: Bytes): Promise<string> {
  const { boundedText } = await lazyLoad(import("../agent-loop/tool-result-size.js"));
  const { kept, marker } = boundedText(block, maxResultSize);
  return `${kept}${marker}`;
}

/** A retrieval's spend: the connector's reported cost, and its reranker's calls (#703). */
const recordsOf = (name: string, retrieval: KnowledgeRetrieval): UsageRecord[] => [
  recordReportedCost({ name, costCaller: `rag:${name}` }, retrieval.costUsd ?? 0),
  ...(retrieval.usage ?? []),
];

/** A reranking that failed under `RerankFailurePolicy.FailStep` (by its code: its class loads lazily). */
export const isRerankFailure = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === RERANK_FAILED_CODE;

/**
 * Context mode: before the agent's loop, each knowledge base is asked for the task's top-k
 * search results. Each retrieval is a named runnable (`rag:<name>`), so it is a span in the trace; its
 * cost is billed to `rag:<name>` (category retrieval), a reranker's too (#703). A failure leaves
 * those results out — the turn goes on (fail-open), the error stays on the span — except a reranking
 * that failed under `RerankFailurePolicy.FailStep` (`step.rerank-failed`), which fails the step.
 */
export async function gatherKnowledge(
  sources: readonly KnowledgeSource[],
  query: string,
  config: RunnableConfig | undefined,
  observer?: ExecutionObserverManager,
  maxResultSize: Bytes = DEFAULT_MAX_RESULT_SIZE,
): Promise<{ readonly block: string; readonly records: UsageRecord[] }> {
  const records: UsageRecord[] = [];
  const blocks: string[] = [];
  const signal = config?.signal ?? new AbortController().signal;
  for (const source of sources) {
    try {
      const { name } = source;
      await reportNodeEvent((base) => observer?.onRagStart({ ...base, name, input: query }));
      const retrieval = await RunnableLambda.from((q: string) =>
        source.retrieve(q, { topK: source.topK, signal }),
      ).invoke(query, { ...config, runName: `rag:${source.name}` });
      await reportNodeEvent((base) => observer?.onRagEnd({ ...base, name, update: retrieval }));
      records.push(...recordsOf(source.name, retrieval));
      if (retrieval.results.length > 0)
        blocks.push(
          await boundedBlock(knowledgeBlock(source.name, retrieval.results), maxResultSize),
        );
    } catch (error) {
      // fail-open: knowledge is an aid, not a gate — unless its reranking must fail the step (#703)
      if (isRerankFailure(error)) throw error;
    }
  }
  return {
    block: blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n\n${CITE_INSTRUCTION}\n\n`,
    records,
  };
}
