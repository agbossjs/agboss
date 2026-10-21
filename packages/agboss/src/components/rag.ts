import { z } from "zod";
import { SEARCH_TOOL_SUFFIX } from "../prompts/rag.js";
import { RagMode, type KnowledgeSource, type RagConnector } from "../rag/types.js";
import { defineTool, type AnyTool } from "../tools/index.js";
import type { Class } from "./injection.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";

export type RagMeta = Extract<ReturnType<typeof componentOf>, { kind: "rag" }>["meta"];

/** The `@Rag` classes the workflow's agents bind, checked. */
export function ragClassesOf(bundle: WorkflowMeta, agents: readonly AgentMeta[]): Class[] {
  const classes = [
    ...new Set(agents.flatMap((agent) => (agent.rag ?? []).map((binding) => binding.use))),
  ];
  for (const cls of classes) {
    if (componentOf(cls)?.kind !== "rag") {
      throw new ComponentError(
        `@Workflow "${bundle.name}": ${cls.name} in an agent's rag is not a @Rag`,
      );
    }
  }
  return classes;
}

export const ragMeta = (cls: Class): RagMeta => requireComponent(cls, "rag", "workflowOf").meta;

/** A knowledge base's search tool: `search-jobs-rag-tool` for `jobs-rag` (#268 AC9). */
export const searchToolName = (meta: RagMeta): string => `search-${meta.name}-tool`;

/** An agent's knowledge bases as config entries (for describe and profiles). */
export const ragSettings = (agent: AgentMeta): { name: string; mode: RagMode; topK: number }[] =>
  (agent.rag ?? []).map((binding) => {
    const meta = ragMeta(binding.use);
    return { name: meta.name, mode: binding.mode, topK: meta.topK };
  });

const Output = z.object({
  results: z.array(
    z.object({ source: z.string(), text: z.string(), score: z.number().optional() }),
  ),
});

/** Tool mode: `search-<name>-tool(query)`; its cost is billed to `rag:<name>` (category retrieval). */
export function searchTool(meta: RagMeta, connector: RagConnector): AnyTool {
  const tool = defineTool({
    name: searchToolName(meta),
    description: `${meta.description}. ${SEARCH_TOOL_SUFFIX}`,
    input: z.object({ query: z.string().min(1) }),
    output: Output,
    run: async ({ query }, ctx) => {
      const retrieval = await connector.retrieve(query, { topK: meta.topK, signal: ctx.signal });
      ctx.reportCost(retrieval.costUsd ?? 0);
      return {
        results: retrieval.results.map((result) => ({
          source: result.source,
          text: result.text,
          ...(result.score === undefined ? {} : { score: result.score }),
        })),
      };
    },
  });
  return { ...tool, costCaller: `rag:${meta.name}` };
}

/** Context mode: per agent, the knowledge bases the core retrieves from before the agent runs. */
export function contextSources(
  agents: readonly AgentMeta[],
  instance: (cls: Class) => RagConnector,
): ReadonlyMap<string, readonly KnowledgeSource[]> {
  return new Map(
    agents.map((agent) => [
      agent.name,
      (agent.rag ?? [])
        .filter((binding) => binding.mode === RagMode.Context)
        .map((binding) => {
          const meta = ragMeta(binding.use);
          const connector = instance(binding.use);
          return { name: meta.name, topK: meta.topK, retrieve: connector.retrieve.bind(connector) };
        }),
    ]),
  );
}
