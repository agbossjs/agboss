import { declarationOf } from "../flow/decorators/declaration.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import { tokenName, type Class, type Provider } from "./injection.js";
import { isModelProviderClass } from "../models/model-provider.decorator.js";
import { transportProviderClassesOf } from "../models/resolution.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { ragMeta, searchToolName } from "./rag.js";
import type { PromptLoader } from "./prompt-render.js";
import { channelComponentClassesOf } from "./channel-parts.js";
import type { ProviderModule } from "./container/registrations.js";
import { INFRASTRUCTURE_TOKENS } from "../infrastructure/instance-tokens.js";
import type { Mcp } from "./assemble-tools.js";
import { checkGraph } from "./container/graph-check.js";
import type { Token } from "./injection.js";
import { CORE_TOKENS, rememberServers } from "./runtime.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { MAX_TOOL_NAME_LENGTH } from "../flow/analyse/rules/models.js";

/** A workflow's tool classes: local `@Tool`s and `@McpTool`s. */
export interface ToolClasses {
  readonly local: readonly Class[];
  readonly mcp: readonly Class[];
}

/**
 * Tool classes → the tool names they expose to a model (a `@Rag` → `search-<name>-tool`); a name
 * that breaks the name rules (`toolNameViolations`) or is exposed twice (local, MCP or
 * knowledge-base search) fails assembly — with the `others` found in the tools (their bounds, #336).
 */
export const toolNames = (
  tools: ToolClasses,
  rags: readonly Class[],
  others: readonly RuleViolation[] = [],
): Map<Class, string> => {
  throwIfViolated([...toolNameViolations(tools, rags), ...others]);
  const map = new Map<Class, string>();
  const byName = new Map<string, Class>();

  const add = (cls: Class, name: string): void => {
    const existing = byName.get(name);
    if (existing !== undefined && existing !== cls) {
      throw new ComponentError(
        `[tool.duplicate-name] Duplicate tool name "${name}" found in classes ${tokenName(existing)} and ${tokenName(cls)}. Tool names must be unique across the workflow.`,
      );
    }
    byName.set(name, cls);
    map.set(cls, name);
  };

  tools.local.forEach((cls) => {
    add(cls, requireComponent(cls, "tool", "workflowOf").meta.name);
  });
  tools.mcp.forEach((cls) => {
    add(cls, requireComponent(cls, "mcp-tool", "workflowOf").meta.name);
  });
  rags.forEach((cls) => {
    add(cls, searchToolName(ragMeta(cls)));
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
 * The names of a workflow's tools (#268 AC9): a project's `@Tool` / `@McpTool` is kebab-case and ends
 * with `-tool` (`[name.kind-suffix]`); every name a model sees — a knowledge base's
 * `search-<name>-tool` too — fits the providers' `[a-zA-Z0-9_-]`, at most 64 characters. All at once.
 */
export function toolNameViolations(tools: ToolClasses, rags: readonly Class[]): RuleViolation[] {
  const named = [
    ...tools.local.map((cls) => ({
      cls,
      name: requireComponent(cls, "tool", "workflowOf").meta.name,
    })),
    ...tools.mcp.map((cls) => ({
      cls,
      name: requireComponent(cls, "mcp-tool", "workflowOf").meta.name,
    })),
  ];
  const own = named.flatMap(({ cls, name }) => {
    const problem = kindSuffixProblem(name, NameKind.Tool);
    const owner = tokenName(cls);
    return problem === undefined
      ? modelNameViolations(name, owner)
      : [violation(problem.code, `${owner}: ${problem.message}`, [owner])];
  });
  const searches = rags.flatMap((cls) =>
    modelNameViolations(searchToolName(ragMeta(cls)), tokenName(cls)),
  );
  return [...own, ...searches];
}

/** The classes among a workflow's `providers` (values excluded). */
const providerClassesOf = (bundle: WorkflowMeta): readonly Class[] =>
  (bundle.providers ?? []).flatMap((p) => ("provide" in p ? [] : [p]));

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
  owner?: { readonly providers?: readonly Provider[] },
): Class[] => [
  ...tools.local,
  ...tools.mcp,
  ...rags,
  ...created,
  ...channelComponentClassesOf(tools, modules),
  ...agents.flatMap((a) => a.judges ?? []),
  ...providerClassesOf(bundle),
  ...agents.flatMap((a) => a.memoryStrategy ?? []),
  // the application's transport providers (#385): its container creates them on their first call
  ...transportProviderClassesOf(owner?.providers),
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
      throw new ComponentError(
        `[di.undecorated-provider] @Workflow "${bundle.name}": ${tokenName(cls)} in providers has no decorator — add @Injectable({ deps }) (or the component's own decorator), or register a value with provide(token, value).`,
      );
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
}
