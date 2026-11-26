import { resolveTools, type AssembledWorkflow, type WorkflowServices } from "../workflow.js";
import { DEFAULT_MAX_TOKENS, type Thinking } from "../config/types.js";
import { memoryPlanOf, readerOf } from "../memory/plan.js";
import { resolveAgentLimits, type AgentLimit } from "../graph/agent-loop/index.js";
import { reasoningLabel, reasoningOfThinking } from "../models/reasoning.js";
import { flowLines } from "../flow/print.js";
import { ModelKind } from "../models/model-kind.js";
import { providerKindsOf } from "../models/resolution.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouterNode } from "../flow/runtime/graph-model.js";
import { childLines, inputLines } from "./inputs.js";
import { recursionLines } from "./recursion.js";
import { compensationLines } from "./compensation.js";
import {
  agentDefaultsLine,
  compactionSourceOf,
  maxResultSizeLabel,
  routerModelSource,
} from "./defaults.js";
import { configSnapshot, type ChildSnapshotSources } from "../run/versions.js";
import { shortVersion, versionOf } from "../turns/index.js";
import { isMcpFacade, type AnyTool } from "../tools/index.js";
import { modelProviderLine, resolvedModelUsesOf } from "../models/resolution.js";
import { bundleLines } from "./bundle-lines.js";
import { limitLines } from "./limits.js";
import { contextsOutsideExecution } from "../flow/context/runtime-contexts.js";

/** A knowledge base's reranking as describe prints it (#703). */
const rerankText = (
  rerank:
    | { readonly reranker: string; readonly candidates: number; readonly onFailure: string }
    | undefined,
): string =>
  rerank === undefined
    ? ""
    : `, reranked by ${rerank.reranker} from ${String(rerank.candidates)}, on failure ${rerank.onFailure}`;

/**
 * Tools are built with a router that is never called and the contexts of a workflow outside an
 * application — describing needs no key, no network and no environment.
 */
export const describeServices: WorkflowServices = {
  router: (name) => ({
    name,
    route: () => Promise.reject(new Error("describe does not call routers")),
  }),
  contexts: contextsOutsideExecution({ name: "describe", version: "0.0.0" }),
};

/** A component's reasoning; unset = its model provider's. */
const thinkingLabel = (thinking: Thinking | undefined): string =>
  thinking === undefined ? "the provider's" : reasoningLabel(reasoningOfThinking(thinking));

function toolLine(tool: AnyTool, bundle: AssembledWorkflow): string {
  const kind = isMcpFacade(tool) ? `MCP ${tool.mcp.server}` : "local";
  const approval = tool.approval;
  const waits = approval ? ", waits for approval" : "";
  const deps = bundle.toolDependencies?.[tool.name];
  return `${tool.name} (${approval ? `approval:${approval}, ` : ""}${kind}${waits})${deps === undefined ? "" : ` ← ${deps}`} — ${tool.description} · ${maxResultSizeLabel(bundle, tool)}`;
}

/** The start each edge into a child workflow enters through (#263), when the workflow has one. */
function childSection(bundle: AssembledWorkflow): string[] {
  const lines = childLines(bundle.graph.analysis);
  return lines.length === 0 ? [] : ["children", ...lines.map((line) => `  ${line}`)];
}

/** The paths as written, each node's inputs with their producers, each router's model. */
function flowSection(bundle: AssembledWorkflow): string[] {
  return [
    "flow",
    ...flowLines(bundle.graph.flow).map((line) => `  ${line}`),
    "inputs",
    ...inputLines(bundle.graph.analysis).map((line) => `  ${line}`),
    ...childSection(bundle),
    ...recursionLines(bundle.graph.analysis),
    "routers",
    ...routerLines(bundle),
    ...compensationLines(bundle),
  ];
}

const visitsLabel = (maxVisits: number | undefined): string =>
  maxVisits === undefined ? "" : ` · maxVisits ${String(maxVisits)}`;

/** Each router: its model (decision or chat), or `code` for one decided by its `route()` (#280). */
function routerLines(bundle: AssembledWorkflow): string[] {
  const kinds = providerKindsOf(bundle.modelProviders);
  const models = bundle.routers.map(
    (router) =>
      `  ${router.name}  ${router.modelProvider !== undefined && kinds.get(router.modelProvider) === ModelKind.Decisions ? "decisions" : "llm"} ${router.model} ${routerModelSource(bundle, router)}${visitsLabel(router.maxVisits)} — ${router.description}`,
  );
  const code = [...bundle.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Router && isCodeRouterNode(node)
      ? [
          `  ${node.id}  code${visitsLabel(node.maxVisits)} — ${node.declaration.options.description}`,
        ]
      : [],
  );
  return [...models, ...code];
}

const ceilingLabel = (maxTokens: number | "max" | undefined): string =>
  maxTokens === "max"
    ? "no output ceiling"
    : `max ${String(maxTokens ?? DEFAULT_MAX_TOKENS)} tokens`;

/** `limits: modelCalls 12 (default) · toolCalls 8` — what one call of the agent may do. */
function limitsLine(
  agent: AssembledWorkflow["config"]["agents"][string],
  config: AssembledWorkflow["config"],
): string {
  const { limits, defaulted } = resolveAgentLimits(agent, config.defaults.tools?.maxToolCalls);
  const label = (limit: AgentLimit): string =>
    `${limit} ${String(limits[limit])}${defaulted.includes(limit) ? " (default)" : ""}`;
  return `    limits: ${label("modelCalls")} · ${label("toolCalls")}`;
}

/** An agent's limits and knowledge bases. */
function settingsLines(
  agent: AssembledWorkflow["config"]["agents"][string],
  config: AssembledWorkflow["config"],
): string[] {
  return [
    limitsLine(agent, config),
    ...(agent.rag ?? []).map(
      (kb) => `    rag: ${kb.name} (k ${String(kb.topK)}, ${kb.scope}${rerankText(kb.rerank)})`,
    ),
  ];
}

function agentLines(bundle: AssembledWorkflow, tools: ReadonlyMap<string, AnyTool>): string[] {
  const c = bundle.config;
  const plan = memoryPlanOf(c, bundle.memories);
  return Object.entries(c.agents).flatMap(([name, agent]) => {
    const reader = readerOf(plan, name);
    const compaction =
      reader.compaction === undefined
        ? ""
        : ` · compaction ${reader.compaction.name} ${compactionSourceOf(bundle, name)}`;
    const history = `uncompactedTurns ${String(reader.window)}${compaction}`;
    const own = (agent.tools ?? []).map((t) => tools.get(t));
    return [
      `  ${name}  ${agent.model} · reasoning ${thinkingLabel(agent.thinking ?? c.defaults.models.thinking)} · ${ceilingLabel(agent.maxTokens ?? c.defaults.models.maxTokens)} · ${history}`,
      `    ${agent.description}`,
      ...settingsLines(agent, c),
      agentDefaultsLine(bundle, agent),
      ...(own.length === 0
        ? ["    tools: none"]
        : own.map(
            (tool, i) =>
              `    · ${tool === undefined ? `${agent.tools?.[i] ?? "?"} (not in the catalog)` : toolLine(tool, bundle)}`,
          )),
    ];
  });
}

/**
 * The workflow at a glance: its guardrails and PII policies, settings, the flow as transitions, each
 * node's inputs, its count limits with the worst case of each start, the provider of each model,
 * and which agent can use which tool. Its application — implementations, budgets —
 * is `describeApplication`'s (#268).
 */
export function describeWorkflow(
  bundle: AssembledWorkflow,
  profile = "base",
  children?: ChildSnapshotSources,
): string[] {
  const c = bundle.config;
  const tools = new Map(
    resolveTools(bundle, describeServices).map((tool) => [tool.name, tool] as const),
  );
  const assigned = new Set(Object.values(c.agents).flatMap((agent) => agent.tools ?? []));
  const unassigned = [...tools.keys()].filter((name) => !assigned.has(name));
  return [
    `${c.name} ${c.version}${profile === "base" ? "" : ` (profile ${profile})`} · config ${shortVersion(versionOf(configSnapshot(bundle, children)))}`,
    ...bundleLines(bundle),
    ...flowSection(bundle),
    ...limitLines(bundle),
    // the provider each model resolves to by `serves` (#266), though no component names one
    "models",
    ...resolvedModelUsesOf(bundle).map((use) => `  ${modelProviderLine(use)}`),
    "agents",
    ...agentLines(bundle, tools),
    `unassigned tools: ${unassigned.join(", ") || "none"}`,
  ];
}
