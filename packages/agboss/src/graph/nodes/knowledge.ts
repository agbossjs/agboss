import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import type { UsageRecord } from "../../finops/usage.js";
import { CITE_INSTRUCTION, knowledgeBlock } from "../../prompts/rag.js";
import { RERANK_FAILED_CODE, type KnowledgeSource } from "../../rag/types.js";
import { retrievalRecordsOf } from "../../rag/retrieval-spend.js";
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

/** A reranking that failed under `RerankFailurePolicy.FailStep` (by its code: its class loads lazily). */
export const isRerankFailure = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === RERANK_FAILED_CODE;

/**
 * Before the agent's loop, each knowledge base is asked for the task's top-k search results. Each
 * retrieval is a named runnable (`rag:<name>`), so it is a span in the trace; its cost and tokens
 * are billed to `rag:<name>`, a reranker's to `reranker:<name>` (both the rag category). A failure
 * fails the step — a broken endpoint, credentials, a source that cannot name its scope, a reranker
 * that failed under `RerankFailurePolicy.FailStep` (the default), a block rule of a PII policy on
 * what the reranker's model would read — never a silent turn without the knowledge the agent was
 * given. A knowledge base that is allowed to degrade says so: its `RagReranker` has
 * `onFailure: RerankFailurePolicy.Fallback`.
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
    const { name } = source;
    await reportNodeEvent((base) => observer?.onRagStart({ ...base, name, input: query }));
    const retrieval = await RunnableLambda.from((q: string) =>
      source.retrieve(q, { topK: source.topK, signal }),
    ).invoke(query, { ...config, runName: `rag:${source.name}` });
    await reportNodeEvent((base) => observer?.onRagEnd({ ...base, name, output: retrieval }));
    records.push(...retrievalRecordsOf(source.name, retrieval));
    if (retrieval.results.length > 0)
      blocks.push(
        await boundedBlock(knowledgeBlock(source.name, retrieval.results), maxResultSize),
      );
  }
  return {
    block: blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n\n${CITE_INSTRUCTION}\n\n`,
    records,
  };
}
