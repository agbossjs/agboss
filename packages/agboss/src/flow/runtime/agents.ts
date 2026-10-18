import { withoutUndefined } from "../../types/defined.js";
import type { AgentMeta } from "../../components/meta-types.js";
import { NodeKind } from "../ast.js";
import type { AgentDeclaration } from "../decorators/declaration.js";
import type { RuntimeGraph } from "./graph-model.js";

/**
 * The agents of a v2 workflow as assembly reads them: each `@Agent`'s options in the form the
 * config, the model registry and the agent loop are built from (`reasoning` is the config's
 * reasoning setting; `input` / `output` stay with the graph).
 */

function agentMetaOf(declaration: AgentDeclaration): AgentMeta {
  const { options, source } = declaration;
  return withoutUndefined({
    name: options.name,
    description: options.description,
    prompt: options.prompt,
    promptUrls: options.promptUrls,
    model: options.model,
    memoryStrategy: options.memoryStrategy,
    price: options.price,
    thinking: options.reasoning,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    promptVariables: options.promptVariables,
    cache: options.cache,
    historyLimit: options.historyLimit,
    historySummaries: options.historySummaries,
    maxToolCalls: options.maxToolCalls,
    tools: options.tools,
    judges: options.judges,
    maxRetries: options.maxRetries,
    rag: options.rag,
    source,
    piiPolicies: options.piiPolicies,
    excludePiiPolicies: options.excludePiiPolicies,
    guardrails: options.guardrails,
    overrideGuardrails: options.overrideGuardrails,
    disableGuardrails: options.disableGuardrails,
  });
}

/** Every agent of the graph, by node order (sorted by name). */
export function agentMetasOf(graph: RuntimeGraph): readonly AgentMeta[] {
  return [...graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent ? [agentMetaOf(node.declaration)] : [],
  );
}
