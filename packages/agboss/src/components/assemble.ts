import { withAgentFiles } from "../files/assemble-files.js";
import type { AgentsConfigOf } from "../config/types.js";
import {
  memoryOf,
  optionsOf,
  patchedConfig,
  patchedPrompts,
  profiledBundle,
  windowOf,
  type WorkflowPatch,
} from "./profiled.js";
import { validateAgentsConfig } from "../config/types.js";
import { analyseWorkflow, type FlowAnalysis } from "../flow/analyse/analyse.js";
import { maxStepsOf as stepsLimitOf } from "../flow/analyse/steps.js";
import { agentMetasOf } from "../flow/runtime/agents.js";
import { runtimeGraphOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import { loadRouters } from "../flow/runtime/routers.js";
import type { AssembledWorkflow } from "../workflow.js";
import { providerModulesOf, ragParts, toolBuilder } from "./runtime.js";
import {
  mcpOf,
  mcpPartsOf,
  mcpServerClassesOf,
  resultSizeViolations,
  toolsOf,
} from "./assemble-tools.js";
import { checkedRagClassesOf } from "./rag.js";
import type { Class, Provider, Token } from "./injection.js";
import type { ProviderModule } from "./container/registrations.js";
import { containerPartsOf, toolDependenciesOf } from "./assemble-parts.js";
import { checkComponents, componentClassesOf, promptsOf, toolNames } from "./assemble-checks.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { channelPartsOf, questionRolesOf } from "./channel-parts.js";
import type { ToolClasses } from "./assemble-checks.js";
import { checkedChannelsOf, createdClassesOf } from "./channel-parts.js";
import { PromptLoader } from "./prompt-render.js";
import { configDefaultsOf, moduleOf, workflowDeclarationOf } from "./module.js";
import {
  cascadeDefaults,
  rememberDefaultsLevels,
  type DefaultsLevels,
} from "../config/defaults.js";
import type { PromptVariables } from "./prompt-variables.js";
import { judgePartsOf, judgeSettingsOf, type AssembledJudges } from "./judge-parts.js";
import { agentSettings } from "./agent-settings.js";
import { memoriesFor, policyPartsOf, type CompactionConfigPart } from "./policy-parts.js";
import {
  cascadedConfigOf,
  levelCascadeOf,
  resolverOf,
  workflowModelPartsOf,
  checkedJudgesOf,
} from "./model-parts.js";
import { settingsOf } from "./workflow-settings.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import type { AssembledMemories } from "../memory/assembly.js";
import { workflowWindowOf } from "../memory/memory.decorator.js";

/** The application a workflow is assembled in: its name, `defaults` and providers (its model providers). */
type WorkflowOwner = NonNullable<DefaultsLevels["application"]> & {
  readonly providers?: readonly Provider[];
  /** `@Application({ piiPolicies })`: every agent's and router's, before the workflow's own (#120). */
  readonly piiPolicies?: readonly Class[];
  /** What the selected profiles (`src/config/`) change of this workflow: its owner as it sees it. */
  readonly patch?: WorkflowPatch;
  /** `@Application({ workflows })`: the ways into a child, for the PII policies it inherits (#1150). */
  readonly workflows?: readonly Class[];
  /** `@Application({ guardrails })`: every agent's and model router's (#120). */
  readonly guardrails?: readonly Class[];
  /** `@Application({ toolInterceptors })`: every agent's tool calls (#384). */
  readonly toolInterceptors?: readonly Class[];
  /** `@Application({ workingCalendar })`: the default calendar of working-time deadlines (#944). */
  readonly workingCalendar?: WorkingCalendarSource;
  /** `@Application({ modelProvider })`: the provider of every model that names none (#1313). */
  readonly modelProvider?: Class;
  /** `@Application({ promptVariables })`: under every workflow's and component's own (#1347c). */
  readonly promptVariables?: PromptVariables;
};

function configOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  names: ReadonlyMap<Class, string>,
  judges: AssembledJudges,
  memories: AssembledMemories & CompactionConfigPart,
): AgentsConfigOf<string> {
  return {
    name: bundle.name,
    version: bundle.version,
    defaults: bundle.defaults,
    ...(Object.keys(memories.settings).length === 0 ? {} : { memories: memories.settings }),
    ...judgeSettingsOf(judges.classes),
    agents: Object.fromEntries(
      agents.map((agent) => [agent.name, agentSettings(agent, names, bundle.memoryOverrides)]),
    ),
  };
}

/**
 * The agents' tool classes, and the question roles asked — by the flow's steps (#659) and by the
 * agents' tool loops (#712).
 */
function toolClassesOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  graph: RuntimeGraph,
): ToolClasses {
  const tools = toolsOf(bundle, agents);
  const questions = [...new Set([...questionRolesOf(graph), ...(tools.asked ?? [])])];
  return { ...tools, questions };
}

/** Steps per execution: `maxSteps`, else (agents + routers) × 3. */
const maxStepsOf = (workflow: Class, graph: RuntimeGraph): number =>
  stepsLimitOf(graph.analysis.graph, workflowDeclarationOf(workflow).options.maxSteps);

/**
 * The workflow's module with its defaults merged over its application's (#261 cascade) — its
 * window too: its `memory`'s (#1303).
 */
function withApplicationDefaults(
  bundle: WorkflowMeta,
  workflow: Class,
  owner: WorkflowOwner | undefined,
): WorkflowMeta {
  const { options } = workflowDeclarationOf(workflow);
  const modelCascade = levelCascadeOf(options, owner);
  if (owner === undefined) return { ...bundle, modelCascade };
  const defaults = cascadeDefaults(owner.defaults, options.defaults);
  return {
    ...bundle,
    defaults: configDefaultsOf(
      defaults,
      workflowWindowOf(memoryOf(options, owner.patch), owner.patch?.memoryOverrides),
    ),
    modelCascade,
  };
}

/** The workflow's module over its application's defaults, and its paths analysed with them. */
function analysedModule(
  workflow: Class,
  owner: WorkflowOwner | undefined,
): { readonly bundle: WorkflowMeta; readonly analysis: FlowAnalysis } {
  const applicationDefaults = owner?.defaults;
  return {
    bundle: withApplicationDefaults(moduleOf(workflow), workflow, owner),
    analysis: analyseWorkflow(workflow, {
      ...(applicationDefaults === undefined ? {} : { applicationDefaults }),
    }),
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
      uncompactedTurns: windowOf(memoryOf(options, owner?.patch), owner?.patch),
    },
  };
};

/** The workflow's runtime graph, with the levels its defaults came from remembered (#261). */
function graphOf(analysis: FlowAnalysis, workflow: Class, owner: WorkflowOwner | undefined) {
  const { flow } = workflowDeclarationOf(workflow).options;
  const graph = runtimeGraphOf(analysis, flow, workflow, owner?.defaults?.workflows?.placement);
  rememberDefaultsLevels(graph, levelsOf(workflow, owner));
  return graph;
}

/** The workflow's module, its runtime graph and its agents: its paths analysed with the defaults it cascades. */
function graphedModule(workflow: Class, owner: WorkflowOwner | undefined) {
  const { bundle: declared, analysis } = analysedModule(workflow, owner);
  const bundle = profiledBundle(declared, owner?.patch);
  const graph = graphOf(analysis, workflow, owner);
  return { bundle, graph, agents: agentMetasOf(graph) };
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<AssembledWorkflow> {
  const { bundle, graph, agents } = graphedModule(workflow, owner);
  const loader = PromptLoader.of(bundle, owner, env);
  const resolver = resolverOf(bundle, agents);
  const routers = await loadRouters(graph, loader, bundle.defaults.router?.model, resolver);
  const tools = toolClassesOf(bundle, agents, graph);
  const rags = await checkedRagClassesOf(bundle, agents, tools.local);
  const { judges, modelPrompts } = await checkedJudgesOf(bundle, agents, loader, graph, rags);
  const sources = { workflow, bundle, owner, agents, graph, loader };
  const policies = await policyPartsOf({ ...sources, resolver });
  const memories = await memoriesFor({ bundle, agents, graph, loader });
  const modules = [...providerModulesOf(bundle), ...application];
  const replyInterpreters = await checkedChannelsOf(workflow, modules, owner, loader, resolver);
  const created = createdClassesOf(graph, policies.classes, replyInterpreters, memories);
  const components = componentClassesOf(bundle, agents, tools, rags, created, modules, owner);
  const files = { ...sources, pii: policies.assembled.pii, options: optionsOf(owner?.patch) };
  const mcp = mcpOf(mcpServerClassesOf(components, modules), files.options);
  checkComponents(bundle, { components, modules, mcp, contexts });
  const names = toolNames(tools, resultSizeViolations(bundle, tools));
  const plain = withAgentFiles(configOf(bundle, agents, names, judges, memories), files);
  const config = cascadedConfigOf(patchedConfig(plain, owner?.patch), bundle, agents, resolver);
  validateAgentsConfig(config, [...names.values()]);
  return {
    config,
    graph,
    maxSteps: maxStepsOf(workflow, graph),
    ...containerPartsOf(bundle),
    ...policies.assembled,
    ...channelPartsOf(bundle, tools, owner?.workingCalendar, modules),
    ...workflowModelPartsOf(
      { owner, bundle, agents, config, routers, graph, resolver, modelPrompts },
      { ...policies.models, replyInterpreters, rags },
    ),
    onIncompatibleResume: settingsOf(workflow).onIncompatibleResume,
    routers,
    prompts: patchedPrompts(await promptsOf(agents, loader), owner?.patch),
    tools: toolBuilder(bundle, tools),
    ...(rags.length === 0 ? {} : ragParts(bundle, agents, rags)),
    ...judgePartsOf(bundle, judges),
    ...mcpPartsOf(mcp),
    toolDependencies: toolDependenciesOf(bundle, tools.local, names),
    memories,
  };
}
