import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import { tokenName, type Class, type Provider } from "./injection.js";
import { isModelProviderClass } from "../models/model-provider.decorator.js";
import { transportProviderClassesOf } from "../models/resolution.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { rerankerClassesOf } from "./rag.js";
import type { PromptLoader } from "./prompt-render.js";
import { channelComponentClassesOf } from "./channel-parts.js";
import { channelNameOf } from "../channels/discovery.js";
import type { ProviderModule } from "./container/registrations.js";
import { INFRASTRUCTURE_TOKENS } from "../infrastructure/in-memory-database.js";
import { infrastructureContractOf } from "../infrastructure/contracts.js";
import type { Mcp } from "./assemble-tools.js";
import { checkGraph } from "./container/graph-check.js";
import { depsOf } from "./container/container.js";
import {
  businessKeyWriterUseOf,
  rememberBusinessKeyWriter,
  tokenClassesOf,
} from "./container/fenced-reach.js";
import type { Token } from "./injection.js";
import { CORE_TOKENS, rememberServers } from "./runtime.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";
import { MAX_TOOL_NAME_LENGTH } from "../flow/analyse/rules/models.js";
import { toolExpiryViolations } from "./tool-expiry-rules.js";

/** A workflow's tool classes: local `@Tool`s. */
export interface ToolClasses {
  readonly local: readonly Class[];
  /** The question roles the flow asks (#659), and its agents (#712): channels, not tools. */
  readonly questions?: readonly Class[];
  /** The question roles the agents ask through their tool loop (#712): tools to their models. */
  readonly asked?: readonly Class[];
}

/**
 * Tool classes → the tool names they expose to a model; a name
 * that breaks the name rules (`toolNameViolations`) or is exposed twice (local, MCP
 * or question role) fails assembly — with the `others` found in the tools (their bounds, #336).
 */
export const toolNames = (
  tools: ToolClasses,
  others: readonly RuleViolation[] = [],
): Map<Class, string> => {
  throwIfViolated([...toolNameViolations(tools), ...others]);
  const map = new Map<Class, string>();
  const byName = new Map<string, Class>();

  const add = (cls: Class, name: string): void => {
    const existing = byName.get(name);
    if (existing !== undefined && existing !== cls) {
      throw new ComponentError({
        message: `[tool.duplicate-name] Duplicate tool name "${name}" found in classes ${tokenName(existing)} and ${tokenName(cls)}. Tool names must be unique across the workflow.`,
      });
    }
    byName.set(name, cls);
    map.set(cls, name);
  };

  tools.local.forEach((cls) => {
    add(cls, requireComponent(cls, "tool", "workflowOf").meta.name);
  });
  (tools.asked ?? []).forEach((cls) => {
    add(cls, channelNameOf(cls));
  });

  return map;
};

/** What every provider accepts as the name of a tool a model sees (OpenAI, Anthropic, Gemini). */
const MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** `[tool.name-too-long]` / `[tool.name-invalid]` for a name a model would see, or nothing. */
function modelNameViolations(name: string, owner: string): RuleViolation[] {
  if (MODEL_TOOL_NAME.test(name)) return [];
  if (name.length > MAX_TOOL_NAME_LENGTH)
    return [
      violation(
        "tool.name-too-long",
        `${owner}: the tool name ${name} has ${String(name.length)} characters (at most ${String(MAX_TOOL_NAME_LENGTH)}) — give it a shorter name`,
        [owner],
      ),
    ];
  const message = `${owner}: the tool name "${name}" has characters a model API refuses — letters, digits, "_" and "-" only`;
  return [violation("tool.name-invalid", message, [owner])];
}

/**
 * The names of a workflow's tools (#268 AC9, #1343a): every name a model sees — a project's `@Tool`s
 * (no `-tool` suffix needed for an MCP one) — fits the providers' `[a-zA-Z0-9_-]`, at most 64 characters. All at once.
 */
export function toolNameViolations(tools: ToolClasses): RuleViolation[] {
  const named = [
    ...tools.local.map((cls) => ({
      cls,
      name: requireComponent(cls, "tool", "workflowOf").meta.name,
    })),
  ];
  const own = named.flatMap(({ cls, name }) => modelNameViolations(name, tokenName(cls)));
  // a question role's name is the tool name its agents' models see (#712)
  const questions = (tools.asked ?? []).flatMap((cls) =>
    modelNameViolations(channelNameOf(cls), tokenName(cls)),
  );
  return [...own, ...questions, ...toolExpiryViolations(tools)];
}

/** The classes among a workflow's `providers` (values excluded). */
const providerClassesOf = (bundle: WorkflowMeta): readonly Class[] =>
  [...(bundle.providers ?? []), ...(bundle.services ?? [])].flatMap((p) =>
    "provide" in p ? [] : [p],
  );

/**
 * Every class the container creates for the workflow, for the dependency graph check; `created` =
 * its code nodes, its PII policies and its guardrails (#120).
 */
export const componentClassesOf = (
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  tools: ToolClasses,
  rags: readonly Class[],
  created: readonly Class[],
  modules: readonly ProviderModule[],
  owner?: {
    readonly providers?: readonly Provider[];
    readonly workingCalendar?: WorkingCalendarSource;
  },
): Class[] => [
  ...tools.local,
  ...rags,
  ...rerankerClassesOf(rags),
  ...created,
  ...channelComponentClassesOf(tools, modules),
  ...agents.flatMap((a) => a.judges ?? []),
  ...providerClassesOf(bundle),
  // the application's transport providers (#385): its container creates them on their first call
  ...transportProviderClassesOf(owner?.providers),
  // the application's default calendar class (#944), created by its container
  ...(typeof owner?.workingCalendar === "function" ? [owner.workingCalendar] : []),
];

/**
 * Whether a framework decorator marks the class (a component, a flow node, or a `@ModelProvider` —
 * misplaced in a workflow, reported by the application as `[di.infrastructure-in-workflow]`).
 */
const isDecorated = (cls: Class): boolean =>
  componentOf(cls) !== undefined || declarationOf(cls) !== undefined || isModelProviderClass(cls);

/** Every class in `providers` carries a decorator — the container cannot know an undecorated one's deps. */
export function checkProviderClasses(bundle: WorkflowMeta): void {
  for (const cls of providerClassesOf(bundle)) {
    if (!isDecorated(cls)) {
      throw new ComponentError({
        message: `[di.undecorated-provider] @Workflow "${bundle.name}": ${tokenName(cls)} in providers has no decorator — add @Injectable({ deps }) (or the component's own decorator), or register a value with provide(token, value).`,
      });
    }
  }
}

/**
 * Each agent's prompt, read and checked, with the workflow's and the agent's own `{{variables}}`;
 * every prompt problem the loader saw (the routers' too) fails here, all at once.
 */
export const promptsOf = async (
  agents: readonly AgentMeta[],
  loader: PromptLoader,
): Promise<Record<string, string>> => {
  const prompts = await Promise.all(
    agents.map(async (agent) => {
      const prompt = await loader.load({
        label: `@Agent "${agent.name}"`,
        options: agent,
        source: agent.source,
        ...(agent.promptVariables === undefined ? {} : { variables: agent.promptVariables }),
      });
      return [agent.name, prompt] as const;
    }),
  );
  loader.throwIfAny();
  return Object.fromEntries(prompts);
};

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

/**
 * The services the application and its workflows list (#825): the classes a component reaching an
 * abstract token is given — never infrastructure, which a component reaches through its `deps`.
 */
const listedServicesOf = (modules: readonly ProviderModule[]): readonly Class[] =>
  modules.flatMap((module) =>
    module.providers.flatMap((provider) =>
      typeof provider === "function" && infrastructureContractOf(provider) === undefined
        ? [provider]
        : [],
    ),
  );

/** Every component's dependencies checked against the providers; the MCP servers kept. */
export function checkComponents(
  bundle: WorkflowMeta,
  parts: {
    readonly components: Parameters<typeof checkGraph>[0];
    readonly modules: readonly ProviderModule[];
    readonly mcp: Mcp;
    readonly contexts: readonly Token[];
  },
): void {
  checkGraph(parts.components, parts.modules, coreTokensOf(parts.mcp, parts.contexts));
  rememberServers(bundle, parts.mcp.instances);
  // #825: a component that can make a business key — its application names an idempotency key
  const roots = [...parts.components, ...listedServicesOf(parts.modules)];
  const classesOf = tokenClassesOf(parts.modules.flatMap((module) => module.providers));
  rememberBusinessKeyWriter(bundle, businessKeyWriterUseOf(roots, depsOf, classesOf));
}
