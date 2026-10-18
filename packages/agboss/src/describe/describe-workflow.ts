import { resolveTools, type AssembledWorkflow, type WorkflowServices } from "../workflow.js";
import { DEFAULT_MAX_TOKENS, type Thinking } from "../config/types.js";
import { resolveAgentLimits, type AgentLimit } from "../graph/agent-loop/index.js";
import { reasoningLabel, reasoningOfThinking } from "../models/reasoning.js";
import { flowLines } from "../flow/print.js";
import { stepsRangeOf } from "../flow/analyse/steps.js";
import { isDecisionModel } from "../graph/router-model.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouterNode } from "../flow/runtime/graph-model.js";
import { aboutLines, inputLines } from "./inputs.js";
import { agentDefaultsLine, routerModelSource } from "./defaults.js";
import { configSnapshot } from "../run/versions.js";
import { shortVersion, versionOf } from "../terns/index.js";
import { isMcpFacade, type AnyTool } from "../tools/index.js";
import { NO_ENVIRONMENT_VALUES, type DescribedEnvironment } from "../environments/resolve.js";
import { modelProviderLine, resolvedModelUsesOf } from "../models/resolution.js";

/**
 * Tools are built with a router that is never called and, unless one is given, an empty environment —
 * describing needs no key, no network and no environment.
 */
export const describeServices: WorkflowServices = {
  router: (name) => ({
    name,
    route: () => Promise.reject(new Error("describe does not call routers")),
  }),
  environment: NO_ENVIRONMENT_VALUES,
};

/** A component's reasoning; unset = its model provider's. */
const thinkingLabel = (thinking: Thinking | undefined): string =>
  thinking === undefined ? "the provider's" : reasoningLabel(reasoningOfThinking(thinking));

function toolLine(tool: AnyTool, bundle: AssembledWorkflow): string {
  const kind = isMcpFacade(tool) ? `MCP ${tool.mcp.server}` : "local";
  const waits = tool.channel ? ", uses channel" : "";
  const deps = bundle.toolDependencies?.[tool.name];
  return `${tool.name} (${tool.channel ? `channel:${tool.channel}, ` : ""}${kind}${waits})${deps === undefined ? "" : ` ← ${deps}`} — ${tool.description}`;
}

function bundleLines(bundle: AssembledWorkflow): string[] {
  const c = bundle.config;
  const inputGuards = Object.entries(c.guards?.input ?? {}).map(
    ([n, g]) => `${n} ≥${String(g.threshold)}`,
  );
  const outputGuards = Object.entries(c.guards?.output ?? {}).map(
    ([n, g]) => `${n} ≥${String(g.threshold)}`,
  );
  const memory =
    c.compaction === undefined
      ? "raw turns only"
      : `compaction every ${String(c.compaction.every)} turns, keep ${String(c.compaction.keep)} summaries · ${c.compaction.model.model}`;
  return [
    `guards    input: ${inputGuards.join(", ") || "none"} · output: ${outputGuards.join(", ") || "none"}`,
    `memory    ${memory}`,
    `pause     on — tools with channel wait for external signal`,
    `limits    ${limitsLabel(bundle)}`,
  ];
}

/** `steps 3–9 (maxSteps 12) · run $0.1 · day $1`: the steps range (#261) and the cost limits. */
function limitsLabel(bundle: AssembledWorkflow): string {
  const { perRun, perDay } = bundle.limits;
  const range = stepsRangeOf(bundle.graph.analysis.graph);
  const most = range.most === undefined ? "" : `–${String(range.most)}`;
  const steps = `steps ${String(range.least)}${most} (maxSteps ${String(bundle.maxSteps)})`;
  const runCost = perRun?.cost === undefined ? "" : ` · run $${String(perRun.cost)}`;
  const day = perDay?.cost === undefined ? "no daily cap" : `$${String(perDay.cost)}`;
  return `${steps}${runCost} · day ${day}`;
}

/** Each value written with `{ about }` (#271, #299), when the workflow has one. */
function aboutSection(bundle: AssembledWorkflow): string[] {
  const lines = aboutLines(bundle.graph.analysis);
  return lines.length === 0 ? [] : ["about", ...lines.map((line) => `  ${line}`)];
}

/** The paths as written, each node's inputs with their producers, each `about`, each router's model. */
function flowSection(bundle: AssembledWorkflow): string[] {
  return [
    "flow",
    ...flowLines(bundle.graph.flow).map((line) => `  ${line}`),
    "inputs",
    ...inputLines(bundle.graph.analysis).map((line) => `  ${line}`),
    ...aboutSection(bundle),
    "routers",
    ...routerLines(bundle),
  ];
}

const visitsLabel = (maxVisits: number | undefined): string =>
  maxVisits === undefined ? "" : ` · maxVisits ${String(maxVisits)}`;

/** Each router: its model (decision or chat), or `code` for one decided by its `route()` (#280). */
function routerLines(bundle: AssembledWorkflow): string[] {
  const models = bundle.routers.map(
    (router) =>
      `  ${router.name}  ${isDecisionModel(router.model) ? "decisions" : "llm"} ${router.model} ${routerModelSource(bundle, router)}${visitsLabel(router.maxVisits)} — ${router.description}`,
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
  const { limits, defaulted } = resolveAgentLimits(
    agent.maxToolCalls,
    config.defaults.tools?.maxToolCalls,
  );
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
    ...(agent.rag ?? []).map((kb) => `    rag: ${kb.name} (${kb.mode}, k ${String(kb.topK)})`),
  ];
}

function agentLines(bundle: AssembledWorkflow, tools: ReadonlyMap<string, AnyTool>): string[] {
  const c = bundle.config;
  const defaultSummaries = c.defaults.history.summaries ?? c.compaction?.keep ?? 0;
  return Object.entries(c.agents).flatMap(([name, agent]) => {
    const summaries = c.compaction === undefined ? 0 : (agent.historySummaries ?? defaultSummaries);
    const history = `history ${String(agent.historyLimit ?? c.defaults.history.limit)} turns${summaries > 0 ? ` + ${String(summaries)} summaries` : ""}`;
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

/** Describing services with the app's environment (its tools may inject `ENV`). */
export const describeServicesWith = (
  environment: DescribedEnvironment | undefined,
): WorkflowServices =>
  environment === undefined
    ? describeServices
    : { ...describeServices, environment: environment.values };

const environmentLines = (environment: DescribedEnvironment | undefined): string[] =>
  environment === undefined
    ? []
    : [
        `environment ${environment.name}`,
        ...Object.entries(environment.fields).map(([key, value]) => `  ${key} = ${value}`),
      ];

/** The workflow at a glance: settings, the flow as transitions, and which agent can use which tool. */
export function describeWorkflow(
  bundle: AssembledWorkflow,
  profile = "base",
  environment?: DescribedEnvironment,
): string[] {
  const c = bundle.config;
  const tools = new Map(
    resolveTools(bundle, describeServicesWith(environment)).map(
      (tool) => [tool.name, tool] as const,
    ),
  );
  const assigned = new Set(Object.values(c.agents).flatMap((agent) => agent.tools ?? []));
  const unassigned = [...tools.keys()].filter((name) => !assigned.has(name));
  return [
    `${c.name} ${c.version}${profile === "base" ? "" : ` (profile ${profile})`} · config ${shortVersion(versionOf(configSnapshot(bundle)))}`,
    ...bundleLines(bundle),
    ...environmentLines(environment),
    ...flowSection(bundle),
    // the provider each model resolves to by `serves` (#266), though no component names one
    "models",
    ...resolvedModelUsesOf(bundle).map((use) => `  ${modelProviderLine(use)}`),
    "agents",
    ...agentLines(bundle, tools),
    `unassigned tools: ${unassigned.join(", ") || "none"}`,
  ];
}
