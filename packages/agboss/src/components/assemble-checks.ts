import { declarationOf } from "../flow/decorators/declaration.js";
import { ComponentError, componentOf, requireComponent, type ToolMeta } from "./metadata.js";
import { tokenName, type Class } from "./injection.js";
import { isModelProviderClass } from "../models/model-provider.decorator.js";
import type { AgentMeta, PolicyFields, WorkflowMeta } from "./meta-types.js";
import { ragMeta, searchToolName } from "./rag.js";
import type { PromptLoader } from "./prompt-render.js";
import { channelComponentClassesOf } from "./channel-parts.js";

/** A workflow's tool classes: local `@Tool`s and `@McpTool`s. */
export interface ToolClasses {
  readonly local: readonly Class[];
  readonly mcp: readonly Class[];
}

/**
 * Tool classes → the tool names they expose to a model (a `@Rag` → `search_<name>`); a name exposed
 * twice (local, MCP or knowledge-base search) fails assembly.
 */
export const toolNames = (tools: ToolClasses, rags: readonly Class[]): Map<Class, string> => {
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

/** The classes among a workflow's `providers` (values excluded). */
const providerClassesOf = (bundle: WorkflowMeta): readonly Class[] =>
  (bundle.providers ?? []).flatMap((p) => ("provide" in p ? [] : [p]));

/** The policy classes (PII policies, guardrails) an agent or a tool declares. */
const policyClassesOf = (fields: PolicyFields): readonly Class[] => [
  ...(fields.piiPolicies ?? []),
  ...(fields.guardrails ?? []),
  ...(fields.overridePiiPolicies ?? []),
  ...(fields.overrideGuardrails ?? []),
];

/** Every class the container creates for the workflow, for the dependency graph check. */
export const componentClassesOf = (
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  tools: ToolClasses,
  rags: readonly Class[],
  codeNodes: readonly Class[],
): Class[] => [
  ...tools.local,
  ...tools.mcp,
  ...tools.local.flatMap((cls) =>
    policyClassesOf(requireComponent(cls, "tool", "workflowOf").meta),
  ),
  ...rags,
  ...codeNodes,
  ...(bundle.observers ?? []),
  ...(bundle.guardrails ?? []),
  ...(bundle.piiPolicies ?? []),
  ...channelComponentClassesOf(bundle),
  ...agents.flatMap(policyClassesOf),
  ...agents.flatMap((a) => a.judges ?? []),
  ...providerClassesOf(bundle),
  ...agents.flatMap((a) => a.memoryStrategy ?? []),
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

/** Each agent's prompt, read and checked, with the workflow's and the agent's own `{{variables}}`. */
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
  return Object.fromEntries(prompts);
};

/** Every tool with a channel must use one of the workflow's `channelClasses`. */
export function checkToolChannels(bundle: WorkflowMeta, tools: ToolClasses): void {
  const declaredChannels = new Set(
    (bundle.channelClasses ?? []).map(
      (cls) => requireComponent(cls, "channel", "workflowOf").meta.name,
    ),
  );
  const check = (decorator: string, meta: ToolMeta): void => {
    if (!meta.channel) return;
    const channelMeta = requireComponent(meta.channel, "channel", "workflowOf").meta;
    if (!declaredChannels.has(channelMeta.name)) {
      throw new ComponentError(
        `${decorator} "${meta.name}" references a channel not listed in @Workflow channelClasses`,
      );
    }
  };
  for (const cls of tools.local) check("@Tool", requireComponent(cls, "tool", "workflowOf").meta);
  for (const cls of tools.mcp) {
    check("@McpTool", requireComponent(cls, "mcp-tool", "workflowOf").meta);
  }
}
