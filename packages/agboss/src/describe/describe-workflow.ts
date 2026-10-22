import { resolveTools, type AssembledWorkflow, type WorkflowServices } from "../workflow.js";
import { DEFAULT_MAX_TOKENS, type Thinking } from "../config/types.js";
import { memoryPlanOf, readerOf } from "../compaction/plan.js";
import { resolveAgentLimits, type AgentLimit } from "../graph/agent-loop/index.js";
import { reasoningLabel, reasoningOfThinking } from "../models/reasoning.js";
import { flowLines } from "../flow/print.js";
import { isDecisionModel } from "../graph/router-model.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouterNode } from "../flow/runtime/graph-model.js";
import { aboutLines, childLines, inputLines } from "./inputs.js";
import { recursionLines } from "./recursion.js";
import { compensationLines } from "./compensation.js";
import {
  agentDefaultsLine,
  compactionSourceOf,
  maxResultSizeLabel,
  memoryLines,
  routerModelSource,
} from "./defaults.js";
import { configSnapshot, type ChildSnapshotSources } from "../run/versions.js";
import { shortVersion, versionOf } from "../terns/index.js";
import { isMcpFacade, type AnyTool } from "../tools/index.js";
import { NO_ENVIRONMENT_VALUES, type DescribedEnvironment } from "../environments/resolve.js";
import { modelProviderLine, resolvedModelUsesOf } from "../models/resolution.js";
import { applicationContextOf } from "../flow/context/application-context.js";
import { limitLines } from "./limits.js";
import { piiPolicyLines } from "./pii-policies.js";
import { standaloneContexts, type RuntimeContexts } from "../flow/context/runtime-contexts.js";

/** The application context `describe` builds tools with: an empty environment unless one is given. */
const describedApplication = (environment: DescribedEnvironment | undefined): RuntimeContexts => ({
  ...standaloneContexts({ name: "describe", version: "0.0.0" }),
  application: applicationContextOf({
    name: "describe",
    version: "0.0.0",
    instanceId: "describe",
    startedAt: new Date(0),
    environmentName: environment?.name ?? "dev",
    environment: environment?.values ?? NO_ENVIRONMENT_VALUES,
  }),
});

/**
 * Tools are built with a router that is never called and, unless one is given, an empty environment —
 * describing needs no key, no network and no environment.
 */
export const describeServices: WorkflowServices = {
  router: (name) => ({
    name,
    route: () => Promise.reject(new Error("describe does not call routers")),
  }),
  contexts: describedApplication(undefined),
};

/** A component's reasoning; unset = its model provider's. */
const thinkingLabel = (thinking: Thinking | undefined): string =>
  thinking === undefined ? "the provider's" : reasoningLabel(reasoningOfThinking(thinking));

function toolLine(tool: AnyTool, bundle: AssembledWorkflow): string {
  const kind = isMcpFacade(tool) ? `MCP ${tool.mcp.server}` : "local";
  const waits = tool.channel ? ", uses channel" : "";
  const deps = bundle.toolDependencies?.[tool.name];
  return `${tool.name} (${tool.channel ? `channel:${tool.channel}, ` : ""}${kind}${waits})${deps === undefined ? "" : ` ← ${deps}`} — ${tool.description} · ${maxResultSizeLabel(bundle, tool)}`;
}

/**
 * Each guardrail (#120): its side and threshold, its model and where it came from, its refusal —
 * the text, or `Class.refusal()` when the class computes it — and the agents and routers it guards.
 */
function guardrailLines(bundle: AssembledWorkflow): string[] {
  const assembled = bundle.guardrails;
  if (assembled === undefined || assembled.guardrails.length === 0) return ["guardrails none"];
  const users = (type: unknown): string =>
    [...assembled.byElement]
      .filter(([, sides]) => [...sides.input, ...sides.output].some((g) => g.type === type))
      .map(([name]) => name)
      .join(", ") || "none";
  return [
    "guardrails",
    ...assembled.guardrails.map((g) => {
      const model = `${g.model} (${g.isOwnModel ? "own" : "defaults.guardrail"})`;
      const refusal =
        g.refusal === undefined ? `${g.type.name}.refusal()` : JSON.stringify(g.refusal);
      return `  ${g.name} — ${g.side} ≥${String(g.threshold)} · ${model} · refusal: ${refusal} · on ${users(g.type)}`;
    }),
  ];
}

function bundleLines(bundle: AssembledWorkflow): string[] {
  return [
    ...guardrailLines(bundle),
    ...piiPolicyLines(bundle),
    ...memoryLines(bundle),
    `pause     on — tools with channel wait for external signal`,
  ];
}

/** Each value written with `{ about }` (#271, #299), when the workflow has one. */
function aboutSection(bundle: AssembledWorkflow): string[] {
  const lines = aboutLines(bundle.graph.analysis);
  return lines.length === 0 ? [] : ["about", ...lines.map((line) => `  ${line}`)];
}

/** The start each edge into a child workflow enters through (#263), when the workflow has one. */
function childSection(bundle: AssembledWorkflow): string[] {
  const lines = childLines(bundle.graph.analysis);
  return lines.length === 0 ? [] : ["children", ...lines.map((line) => `  ${line}`)];
}

/** The paths as written, each node's inputs with their producers, each `about`, each router's model. */
function flowSection(bundle: AssembledWorkflow): string[] {
  return [
    "flow",
    ...flowLines(bundle.graph.flow).map((line) => `  ${line}`),
    "inputs",
    ...inputLines(bundle.graph.analysis).map((line) => `  ${line}`),
    ...childSection(bundle),
    ...recursionLines(bundle.graph.analysis),
    ...aboutSection(bundle),
    "routers",
    ...routerLines(bundle),
    ...compensationLines(bundle),
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
  const plan = memoryPlanOf(c, bundle.compactions);
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

/** Describing services with the app's environment (its tools may read `applicationContext.environment`). */
export const describeServicesWith = (
  environment: DescribedEnvironment | undefined,
): WorkflowServices =>
  environment === undefined
    ? describeServices
    : { ...describeServices, contexts: describedApplication(environment) };

/**
 * The workflow at a glance: its guardrails and PII policies, settings, the flow as transitions, each
 * node's inputs, its count limits with the worst case of each start, the provider of each model,
 * and which agent can use which tool. Its application — implementations, budgets, the environment —
 * is `describeApplication`'s (#268).
 */
export function describeWorkflow(
  bundle: AssembledWorkflow,
  profile = "base",
  environment?: DescribedEnvironment,
  children?: ChildSnapshotSources,
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
