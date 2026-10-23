import type { AgentsConfigOf } from "../config/types.js";
import { validateAgentsConfig } from "../config/types.js";
import { analyseWorkflow, type FlowAnalysis } from "../flow/analyse/analyse.js";
import { maxStepsOf as stepsLimitOf } from "../flow/analyse/worst-case.js";
import { agentMetasOf } from "../flow/runtime/agents.js";
import { runtimeGraphOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { loadRouters } from "../flow/runtime/routers.js";
import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowSettings } from "../graph/settings.js";
import type { AssembledWorkflow } from "../workflow.js";
import { dependencyTree } from "./container/graph-check.js";
import { providerModulesOf, ragParts, toolBuilder } from "./runtime.js";
import { mcpOf, resultSizeViolations, toolsOf, type Mcp } from "./assemble-tools.js";
import { ragClassesOf } from "./rag.js";
import type { Class, Provider, Token } from "./injection.js";
import type { ProviderModule } from "./container/registrations.js";
import { containerPartsOf } from "./assemble-parts.js";
import {
  checkComponents,
  checkProviderClasses,
  componentClassesOf,
  promptsOf,
  toolNames,
} from "./assemble-checks.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { channelPartsOf } from "./channel-parts.js";
import { checkedChannelsOf, createdClassesOf } from "./channel-parts.js";
import { PromptLoader } from "./prompt-render.js";
import { checkMemoryStrategies, memoryPartsOf } from "./memory-parts.js";
import { configDefaultsOf, moduleOf, workflowDeclarationOf } from "./module.js";
import {
  cascadeDefaults,
  rememberDefaultsLevels,
  type DefaultsLevels,
} from "../config/defaults.js";
import { judgeClassesOf, judgePartsOf, judgeSettingsOf, type JudgeClass } from "./judge-parts.js";
import { agentSettings } from "./agent-settings.js";
import { compactionsFor, policyPartsOf, type CompactionConfigPart } from "./policy-parts.js";
import { modelPartsOf } from "./model-parts.js";
import type { AssembledCompactions } from "../compaction/assembly.js";

import type { UncompactedTurns } from "../compaction/compaction.decorator.js";

/** The application a workflow is assembled in: its name, `defaults` and providers (its model providers). */
type WorkflowOwner = NonNullable<DefaultsLevels["application"]> & {
  readonly providers?: readonly Provider[];
  /** `@Application({ piiPolicies })`: every agent's and router's, before the workflow's own (#120). */
  readonly piiPolicies?: readonly Class[];
  /** `@Application({ guardrails })`: every agent's and model router's (#120). */
  readonly guardrails?: readonly Class[];
  /** `@Application({ compaction, uncompactedTurns })`: every reader's, under its own (#120 PR 3). */
  readonly compaction?: Class;
  readonly uncompactedTurns?: UncompactedTurns;
};

function configOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  names: ReadonlyMap<Class, string>,
  mcp: Mcp,
  judges: ReadonlyMap<string, JudgeClass>,
  compactions: AssembledCompactions & CompactionConfigPart,
): AgentsConfigOf<string> {
  return {
    name: bundle.name,
    version: bundle.version,
    defaults: bundle.defaults,
    ...(compactions.compactions.length === 0 ? {} : { compactions: compactions.settings }),
    ...(mcp.servers.length === 0
      ? {}
      : { mcpServers: Object.fromEntries(mcp.servers.map((s) => [s.name, s.config])) }),
    ...judgeSettingsOf(judges),
    agents: Object.fromEntries(agents.map((agent) => [agent.name, agentSettings(agent, names)])),
  };
}

/** The workflow's MCP servers and the server tools declared on them. */
const mcpPartsOf = (mcp: Mcp): Pick<AssembledWorkflow, "mcpServers" | "serverTools"> => ({
  mcpServers: mcp.handles,
  serverTools: mcp.serverTools,
});

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

/**
 * The workflow's module with its defaults merged over its application's (#261 cascade) — its
 * window too: its own `uncompactedTurns` over the application's (#120 PR 3).
 */
function withApplicationDefaults(
  bundle: WorkflowMeta,
  workflow: Class,
  owner: WorkflowOwner | undefined,
): WorkflowMeta {
  if (owner === undefined) return bundle;
  const { options } = workflowDeclarationOf(workflow);
  const defaults = cascadeDefaults(owner.defaults, options.defaults);
  const window = options.uncompactedTurns ?? owner.uncompactedTurns;
  return { ...bundle, defaults: configDefaultsOf(defaults, window) };
}

/** The workflow's module over its application's defaults, and its paths analysed with them. */
function analysedModule(
  workflow: Class,
  owner: WorkflowOwner | undefined,
): { readonly bundle: WorkflowMeta; readonly analysis: FlowAnalysis } {
  const applicationDefaults = owner?.defaults;
  return {
    bundle: withApplicationDefaults(moduleOf(workflow), workflow, owner),
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
    workflow: {
      name: options.name,
      defaults: options.defaults,
      uncompactedTurns: options.uncompactedTurns,
    },
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
  const { bundle, analysis } = analysedModule(workflow, owner);
  const graph = runtimeGraphOf(analysis, workflowDeclarationOf(workflow).options.flow, workflow);
  const agents = agentMetasOf(graph);
  const loader = new PromptLoader(bundle.promptVariables ?? {});
  const routers = await loadRouters(graph, loader, bundle.defaults.router?.model);
  const tools = toolsOf(bundle, agents);
  const mcp = mcpOf(bundle, tools.mcp);
  const rags = ragClassesOf(bundle, agents);
  checkClasses(bundle, agents);
  const judges = judgeClassesOf(agents);
  const policies = await policyPartsOf({ workflow, bundle, owner, agents, graph, loader });
  const compactions = await compactionsFor({ bundle, owner, agents, graph, loader });
  const modules = [...providerModulesOf(bundle), ...application];
  const replyInterpreters = await checkedChannelsOf(workflow, modules, owner === undefined, loader);
  const created = createdClassesOf(graph, policies.classes, replyInterpreters, compactions);
  const components = componentClassesOf(bundle, agents, tools, rags, created, modules);
  checkComponents(bundle, { components, modules, mcp, contexts });
  const names = toolNames(tools, rags, resultSizeViolations(bundle, tools));
  const prompts = await promptsOf(agents, loader);
  const config = configOf(bundle, agents, names, mcp, judges, compactions);
  validateAgentsConfig(config, [...names.values()]);
  const modelUsers = { ...policies.models, replyInterpreters };
  const models = modelPartsOf(owner, { config, routers }, graph, modelUsers);
  rememberDefaultsLevels(graph, levelsOf(workflow, owner));
  return {
    config,
    graph,
    maxSteps: maxStepsOf(workflow, graph),
    ...containerPartsOf(bundle),
    ...policies.assembled,
    ...channelPartsOf(bundle, tools),
    ...models,
    onIncompatibleResume: settingsOf(workflow).onIncompatibleResume,
    routers,
    prompts,
    tools: toolBuilder(bundle, agents, tools.local, tools.mcp, mcp.names),
    ...(rags.length === 0 ? {} : ragParts(bundle, agents, rags)),
    ...memoryPartsOf(bundle, agents),
    ...judgePartsOf(bundle, judges),
    ...mcpPartsOf(mcp),
    toolDependencies: toolDependenciesOf(bundle, [...tools.local, ...tools.mcp], names),
    compactions,
  };
}
