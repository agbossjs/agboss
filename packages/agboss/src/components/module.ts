import { withoutUndefined } from "../types/defined.js";
import type {
  AgentsConfig,
  ChatDefaults,
  CompactionSettings,
  ModelSettings,
  RouterModel,
} from "../config/types.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf, type WorkflowDeclaration } from "../flow/decorators/declaration.js";
import type {
  CompactionOptions,
  ModelDefaults,
  ModelOptions,
  WorkflowDefaults,
} from "../flow/decorators/workflow.js";
import { isDecisionModel } from "../models/decision-models.js";
import type { Class } from "./injection.js";
import { ComponentError } from "./metadata.js";
import type { WorkflowMeta } from "./meta-types.js";

/**
 * The module of a v2 `@Workflow` (#272): its services, MCP servers, channels, observers, policies,
 * memory and prompt variables, in the form the config and the container read. One object per
 * workflow class — the container is keyed on it.
 */

/** Earlier turns an agent sees when `defaults.history` is not set. */
export const DEFAULT_HISTORY_LIMIT = 5;

/** A model's temperature when neither the component nor `defaults.models` sets one. */
export const DEFAULT_TEMPERATURE = 0;

/** A router model by id: a decision model, or a chat model asked for JSON. */
export const routerModelOfId = (model: string): RouterModel =>
  isDecisionModel(model) ? { kind: "jev", model } : { kind: "llm", model };

const chatDefaultsOf = (models: ModelDefaults | undefined): ChatDefaults =>
  withoutUndefined({
    temperature: models?.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: models?.maxTokens,
    thinking: models?.reasoning,
    cache: models?.cache,
  });

const modelSettingsOf = (options: ModelOptions): ModelSettings =>
  withoutUndefined({
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    thinking: options.reasoning,
    cache: options.cache,
    price: options.price,
  });

const compactionOf = (options: CompactionOptions): CompactionSettings => ({
  every: options.every,
  keep: options.keep,
  model: modelSettingsOf(options.model),
});

export function configDefaultsOf(defaults: WorkflowDefaults | undefined): AgentsConfig["defaults"] {
  return withoutUndefined({
    models: chatDefaultsOf(defaults?.models),
    router: defaults?.router === undefined ? undefined : routerModelOfId(defaults.router.model),
    tools: defaults?.tools,
    history: defaults?.history ?? { limit: DEFAULT_HISTORY_LIMIT },
  });
}

const modules = new WeakMap<Class, WorkflowMeta>();

/** A class's v2 `@Workflow` declaration; anything else is an error naming the fix. */
export function workflowDeclarationOf(workflow: Class): WorkflowDeclaration {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) {
    throw new ComponentError(
      `${workflow.name || "(anonymous class)"} is not a @Workflow class — decorate it with @Workflow({ name, version, flow })`,
    );
  }
  return declaration;
}

/** The module of a `@Workflow` class (cached per class). */
export function moduleOf(workflow: Class): WorkflowMeta {
  const cached = modules.get(workflow);
  if (cached !== undefined) return cached;
  const { options, source } = workflowDeclarationOf(workflow);
  const module: WorkflowMeta = withoutUndefined({
    name: options.name,
    version: options.version,
    source,
    defaults: configDefaultsOf(options.defaults),
    piiPolicies: options.piiPolicies,
    guardrails: options.guardrails,
    compaction: options.compaction === undefined ? undefined : compactionOf(options.compaction),
    compactionPrompt: options.compactionPrompt,
    mcp: options.mcp,
    providers: options.providers,
    promptVariables: options.promptVariables,
  });
  modules.set(workflow, module);
  return module;
}
