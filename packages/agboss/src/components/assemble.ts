import type { AgentsConfigOf } from "../config/types.js";
import { validateAgentsConfig } from "../config/types.js";
import { analyseWorkflow, type FlowAnalysis } from "../flow/analyse/analyse.js";
import { maxStepsOf as stepsLimitOf } from "../flow/analyse/worst-case.js";
import { agentMetasOf } from "../flow/runtime/agents.js";
import { codeClassesOf, runtimeGraphOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { loadRouters } from "../flow/runtime/routers.js";
import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowSettings } from "../graph/settings.js";
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
import type { Class, Provider, Token } from "./injection.js";
import type { ProviderModule } from "./container/registrations.js";
import { INFRASTRUCTURE_TOKENS } from "../infrastructure/instance-tokens.js";
import { containerPartsOf, policyMapsOf } from "./assemble-parts.js";
import {
  checkProviderClasses,
  componentClassesOf,
  promptsOf,
  toolNames,
} from "./assemble-checks.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { channelPartsOf } from "./channel-parts.js";
import { checkChannels } from "../channels/channel-rules.js";
import { PromptLoader } from "./prompt-render.js";
import { checkMemoryStrategies, memoryPartsOf } from "./memory-parts.js";
import { configDefaultsOf, guardsOf, moduleOf, workflowDeclarationOf } from "./module.js";
import {
  cascadeDefaults,
  rememberDefaultsLevels,
  type DefaultsLevels,
} from "../config/defaults.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import { judgeClassesOf, judgePartsOf, judgeSettingsOf, type JudgeClass } from "./judge-parts.js";
import { agentSettings } from "./agent-settings.js";
import { piiPartsOf } from "./pii-parts.js";
import { modelPartsOf } from "./model-parts.js";

/** The application a workflow is assembled in: its name, `defaults` and providers (its model providers). */
type WorkflowOwner = NonNullable<DefaultsLevels["application"]> & {
  readonly providers?: readonly Provider[];
  /** `@Application({ piiPolicies })`: every agent's and router's, before the workflow's own (#120). */
  readonly piiPolicies?: readonly Class[];
};

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

/**
 * What every container of the workflow has besides its providers: core values, the application's
 * context classes (#261), MCP servers.
 */
const coreTokensOf = (mcp: Mcp, contexts: readonly Token[]): readonly Token[] => [
  ...CORE_TOKENS,
  ...contexts,
  ...INFRASTRUCTURE_TOKENS,
  ...mcp.instances.keys(),
];

/** Steps per execution: `maxSteps`, else (agents + routers) × 3. */
const maxStepsOf = (workflow: Class, graph: RuntimeGraph): number =>
  stepsLimitOf(graph.analysis.graph, workflowDeclarationOf(workflow).options.maxSteps);

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
const levelsOf = (workflow: Class, owner: WorkflowOwner | undefined): DefaultsLevels => {
  const { options } = workflowDeclarationOf(workflow);
  return {
    ...(owner === undefined ? {} : { application: owner }),
    workflow: { name: options.name, defaults: options.defaults },
  };
};

/** The workflow's provider classes and its agents' memory strategies, checked before the graph. */
function checkClasses(bundle: WorkflowMeta, agents: readonly AgentMeta[]): void {
  checkProviderClasses(bundle);
  checkMemoryStrategies(agents);
}

/**
 * Assembles a v2 `@Workflow` class into the workflow the core runs (#272): its paths analysed (every
 * rule, all violations at once — before any model call), router and agent texts loaded, config,
 * prompts, tools, MCP; resumes from `settings()`. `application` = the providers of its
 * `@Application` (and of the other workflows): its dependencies may come from them; `owner` = the
 * application itself — its `defaults` and its model providers, each model resolved to one (#266).
 * `contexts` = its context classes (#261), which components may inject.
 */
export async function workflowOf(
  workflow: Class,
  application: readonly ProviderModule[] = [],
  owner?: WorkflowOwner,
  contexts: readonly Token[] = [],
): Promise<AssembledWorkflow> {
  const { bundle, analysis } = analysedModule(workflow, owner?.defaults);
  const graph = runtimeGraphOf(analysis, workflowDeclarationOf(workflow).options.flow, workflow);
  const agents = agentMetasOf(graph);
  const loader = new PromptLoader(bundle.promptVariables ?? {});
  const routers = await loadRouters(graph, loader, bundle.defaults.router?.model);
  const tools = toolsOf(bundle, agents);
  const mcp = mcpOf(bundle, tools.mcp);
  const rags = ragClassesOf(bundle, agents);
  checkClasses(bundle, agents);
  const judges = judgeClassesOf(agents);
  const pii = piiPartsOf(bundle, owner, agents, graph);
  const modules = [...providerModulesOf(bundle), ...application];
  checkChannels(workflow, modules, owner === undefined);
  const created = [...codeClassesOf(graph), ...pii.classes];
  const components = componentClassesOf(bundle, agents, tools, rags, created, modules);
  checkGraph(components, modules, coreTokensOf(mcp, contexts));
  rememberServers(bundle, mcp.instances);
  const names = toolNames(tools, rags);
  const prompts = await promptsOf(agents, loader);
  const config = configOf(bundle, agents, names, mcp, judges);
  validateAgentsConfig(config, [...names.values()]);
  const models = modelPartsOf(owner, { config, routers }, graph, pii.detectors);
  rememberDefaultsLevels(graph, levelsOf(workflow, owner));
  return {
    config,
    graph,
    maxSteps: maxStepsOf(workflow, graph),
    ...containerPartsOf(bundle, policyMapsOf(agents, tools.local, names)),
    pii,
    ...channelPartsOf(bundle, tools),
    ...models,
    onIncompatibleResume: settingsOf(workflow).onIncompatibleResume,
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
