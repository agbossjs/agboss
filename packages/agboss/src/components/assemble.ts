import type { AgentsConfigOf } from "../config/types.js";
import { validateAgentsConfig } from "../config/types.js";
import { analyseWorkflow, type FlowAnalysis } from "../flow/analyse/analyse.js";
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
import type { Class, Token } from "./injection.js";
import type { ProviderModule } from "./container/registrations.js";
import { INFRASTRUCTURE_TOKENS } from "../infrastructure/clock.js";
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
import { configDefaultsOf, guardsOf, moduleOf, workflowDeclarationOf } from "./module.js";
import {
  cascadeDefaults,
  rememberDefaultsLevels,
  type DefaultsLevels,
} from "../config/defaults.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
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

/** What every container of the workflow has besides its providers: core values, MCP servers. */
const coreTokensOf = (mcp: Mcp): readonly Token[] => [
  ...CORE_TOKENS,
  ...INFRASTRUCTURE_TOKENS,
  ...mcp.instances.keys(),
];

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

/** The workflow's module with its defaults merged over its application's (#261 cascade). */
function withApplicationDefaults(
  bundle: WorkflowMeta,
  workflow: Class,
  applicationDefaults: WorkflowDefaults | undefined,
): WorkflowMeta {
  if (applicationDefaults === undefined) return bundle;
  const { options } = workflowDeclarationOf(workflow);
  const defaults = cascadeDefaults(applicationDefaults, options.defaults);
  return {
    ...bundle,
    defaults: configDefaultsOf(defaults),
    guards: guardsOf(options.guards, defaults),
  };
}

/** The workflow's module over its application's defaults, and its paths analysed with them. */
function analysedModule(
  workflow: Class,
  applicationDefaults: WorkflowDefaults | undefined,
): { readonly bundle: WorkflowMeta; readonly analysis: FlowAnalysis } {
  return {
    bundle: withApplicationDefaults(moduleOf(workflow), workflow, applicationDefaults),
    analysis: analyseWorkflow(
      workflow,
      applicationDefaults === undefined ? {} : { applicationDefaults },
    ),
  };
}

/** The levels the workflow's defaults come from: its application's (if any) and its own. */
const levelsOf = (workflow: Class, owner: DefaultsLevels["application"]): DefaultsLevels => {
  const { options } = workflowDeclarationOf(workflow);
  return {
    ...(owner === undefined ? {} : { application: owner }),
    workflow: { name: options.name, defaults: options.defaults },
  };
};

/**
 * Assembles a v2 `@Workflow` class into the workflow the core runs (#272): its paths analysed (every
 * rule, all violations at once — before any model call), router and agent texts loaded, config,
 * prompts, tools, MCP; cost limits and model providers from `settings()`. `application` = the
 * providers of its `@Application` (and of the other workflows): its dependencies may come from them.
 */
export async function workflowOf(
  workflow: Class,
  application: readonly ProviderModule[] = [],
  owner?: DefaultsLevels["application"],
): Promise<AssembledWorkflow> {
  const { bundle, analysis } = analysedModule(workflow, owner?.defaults);
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
  const components = componentClassesOf(bundle, agents, tools, rags, codeNodeClassesOf(graph));
  checkGraph(components, [...providerModulesOf(bundle), ...application], coreTokensOf(mcp));
  rememberServers(bundle, mcp.instances);
  const names = toolNames(tools, rags);
  const prompts = await promptsOf(agents, loader);
  loader.throwIfAny();
  const config = configOf(bundle, agents, names, mcp, judges);
  const settings = settingsOf(workflow);
  validateAgentsConfig(config, [...names.values()]);
  checkToolChannels(bundle, tools);
  checkObservers(bundle.observers ?? []);
  rememberDefaultsLevels(graph, levelsOf(workflow, owner));
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
