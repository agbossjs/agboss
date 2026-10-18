import type { AgentsConfigOf } from "../config/types.js";
import { validateAgentsConfig } from "../config/types.js";
import { analyseWorkflow } from "../flow/analyse/analyse.js";
import { NodeKind } from "../flow/ast.js";
import { agentMetasOf } from "../flow/runtime/agents.js";
import { isCodeNode, runtimeGraphOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { loadRouters } from "../flow/runtime/routers.js";
import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowSettings } from "../graph/settings.js";
import { STEPS_PER_WORKING_NODE } from "../graph/limits.js";
import type { AssembledWorkflow } from "../workflow.js";
import { checkGraph, dependencyTree } from "./container/graph-check.js";
import {
  CORE_TOKENS,
  providerModulesOf,
  ragParts,
  rememberServers,
  toolBuilder,
} from "./runtime.js";
import { mcpOf, toolsOf, type Mcp } from "./assemble-tools.js";
import { ragClassesOf } from "./rag.js";
import type { Class } from "./injection.js";
import { containerPartsOf, policyMapsOf } from "./assemble-parts.js";
import {
  checkProviderClasses,
  checkToolChannels,
  componentClassesOf,
  promptsOf,
  toolNames,
} from "./assemble-checks.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { channelPartsOf } from "./channel-parts.js";
import { PromptLoader } from "./prompt-render.js";
import { checkMemoryStrategies, memoryPartsOf } from "./memory-parts.js";
import { moduleOf, workflowDeclarationOf } from "./module.js";
import { checkObservers } from "./observer-checks.js";
import { judgeClassesOf, judgePartsOf, judgeSettingsOf, type JudgeClass } from "./judge-parts.js";
import { agentSettings } from "./agent-settings.js";

function configOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  names: ReadonlyMap<Class, string>,
  mcp: Mcp,
  judges: ReadonlyMap<string, JudgeClass>,
): AgentsConfigOf<string> {
  return {
    name: bundle.name,
    version: bundle.version,
    defaults: bundle.defaults,
    ...(bundle.guards === undefined ? {} : { guards: bundle.guards }),
    ...(bundle.compaction === undefined ? {} : { compaction: bundle.compaction }),
    ...(mcp.servers.length === 0
      ? {}
      : { mcpServers: Object.fromEntries(mcp.servers.map((s) => [s.name, s.config])) }),
    ...(judges.size === 0 ? {} : { judges: judgeSettingsOf(judges) }),
    agents: Object.fromEntries(agents.map((agent) => [agent.name, agentSettings(agent, names)])),
  };
}

/** Each tool's dependency tree by tool name (tools without dependencies are left out). */
const toolDependenciesOf = (
  bundle: WorkflowMeta,
  tools: readonly Class[],
  names: ReadonlyMap<Class, string>,
): Record<string, string> =>
  Object.fromEntries(
    tools.flatMap((cls) => {
      const tree = dependencyTree(cls, providerModulesOf(bundle));
      return tree === "" ? [] : [[names.get(cls) ?? cls.name, tree] as const];
    }),
  );

/** The code nodes the container creates: actions, finishes with a handler, code routers. */
const codeNodeClassesOf = (graph: RuntimeGraph): readonly Class[] =>
  [...graph.nodes.values()].flatMap((node) => (isCodeNode(node) ? [node.component] : []));

/** Steps per execution: `maxSteps`, else (agents + routers) × 3. */
const maxStepsOf = (workflow: Class, graph: RuntimeGraph): number => {
  const working = [...graph.nodes.values()].filter(
    (node) => node.kind === NodeKind.Agent || node.kind === NodeKind.Router,
  ).length;
  return workflowDeclarationOf(workflow).options.maxSteps ?? working * STEPS_PER_WORKING_NODE;
};

const isDefinition = (value: unknown): value is { settings(): WorkflowSettings } =>
  typeof value === "object" &&
  value !== null &&
  "settings" in value &&
  typeof value.settings === "function";

/** The workflow's `settings()` when it has one (`implements WorkflowDefinition`), else the defaults. */
function settingsOf(workflow: Class): WorkflowSettings {
  // a @Workflow class is constructed with no arguments: it holds declarations only
  const instance: unknown = new (workflow as unknown as new () => unknown)();
  return isDefinition(instance) ? instance.settings() : DEFAULT_WORKFLOW_SETTINGS;
}

/**
 * Assembles a v2 `@Workflow` class into the workflow the core runs (#272): its paths analysed (every
 * rule, all violations at once — before any model call), router and agent texts loaded, config,
 * prompts, tools, MCP; cost limits and model providers from `settings()`.
 */
export async function workflowOf(workflow: Class): Promise<AssembledWorkflow> {
  const bundle = moduleOf(workflow);
  const analysis = analyseWorkflow(workflow);
  const graph = runtimeGraphOf(analysis, workflowDeclarationOf(workflow).options.flow, workflow);
  const agents = agentMetasOf(graph);
  const loader = new PromptLoader(bundle.promptVariables ?? {});
  const routers = await loadRouters(graph, loader, bundle.defaults.router?.model);
  const tools = toolsOf(bundle, agents);
  const mcp = mcpOf(bundle, tools.mcp);
  const rags = ragClassesOf(bundle, agents);
  checkProviderClasses(bundle);
  checkMemoryStrategies(agents);
  const judges = judgeClassesOf(agents);
  checkGraph(
    componentClassesOf(bundle, agents, tools, rags, codeNodeClassesOf(graph)),
    providerModulesOf(bundle),
    [...CORE_TOKENS, ...mcp.instances.keys()],
  );
  rememberServers(bundle, mcp.instances);
  const names = toolNames(tools, rags);
  const prompts = await promptsOf(agents, loader);
  loader.throwIfAny();
  const config = configOf(bundle, agents, names, mcp, judges);
  const settings = settingsOf(workflow);
  validateAgentsConfig(config, [...names.values()]);
  checkToolChannels(bundle, tools);
  checkObservers(bundle.observers ?? []);
  return {
    config,
    graph,
    maxSteps: maxStepsOf(workflow, graph),
    ...containerPartsOf(bundle, policyMapsOf(agents, tools.local, names)),
    ...channelPartsOf(bundle),
    limits: settings.limits,
    models: settings.models,
    onIncompatibleResume: settings.onIncompatibleResume,
    routers,
    prompts,
    tools: toolBuilder(bundle, agents, tools.local, tools.mcp, mcp.names),
    ...(rags.length === 0 ? {} : ragParts(bundle, agents, rags)),
    ...memoryPartsOf(bundle, agents),
    ...judgePartsOf(bundle, judges),
    mcpServers: mcp.handles,
    serverTools: mcp.serverTools,
    toolDependencies: toolDependenciesOf(bundle, [...tools.local, ...tools.mcp], names),
    ...(bundle.compactionPrompt === undefined ? {} : { compactionPrompt: bundle.compactionPrompt }),
  };
}
