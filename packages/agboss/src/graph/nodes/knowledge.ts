import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { recordReportedCost, type UsageRecord } from "../../finops/usage.js";
import { CITE_INSTRUCTION, knowledgeBlock } from "../../prompts/rag.js";
import type { KnowledgeSource } from "../../rag/types.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";

/**
 * Context mode: before the agent's loop, each knowledge base is asked for the task's top-k
 * search results. Each retrieval is a named runnable (`rag:<name>`), so it is a span in the trace; its
 * cost is billed to `rag:<name>` (category retrieval). A failure leaves those results out — the
 * turn goes on (fail-open), the error stays on the span.
 */
export async function gatherKnowledge(
  sources: readonly KnowledgeSource[],
  query: string,
  config: RunnableConfig | undefined,
  observer?: ExecutionObserverManager,
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
      records.push(
        recordReportedCost(
          { name: source.name, costCaller: `rag:${source.name}` },
          retrieval.costUsd ?? 0,
        ),
      );
      if (retrieval.results.length > 0) blocks.push(knowledgeBlock(source.name, retrieval.results));
    } catch {
      // fail-open: knowledge is an aid, not a gate
    }
  }
  return {
    block: blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n\n${CITE_INSTRUCTION}\n\n`,
    records,
  };
}
