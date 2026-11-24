import { workflowWindowOf } from "../memory/memory.decorator.js";
import { withoutUndefined } from "../types/defined.js";
import type { AgentsConfig, ChatDefaults, RouterModel } from "../config/types.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf, type WorkflowDeclaration } from "../flow/decorators/declaration.js";
import type { ModelDefaults, WorkflowDefaults } from "../flow/decorators/workflow.js";
import { isDecisionModel } from "../models/decision-models.js";
import { DEFAULT_UNCOMPACTED_TURNS, type UncompactedTurns } from "../memory/memory.decorator.js";
import type { Class } from "./injection.js";
import { ComponentError } from "./metadata.js";
import type { WorkflowMeta } from "./meta-types.js";

/**
 * The module of a v2 `@Workflow` (#272): its services, MCP servers, channels, observers, policies,
 * memory and prompt variables, in the form the config and the container read. One object per
 * workflow class — the container is keyed on it.
 */

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

/**
 * The config's defaults: the cascaded `defaults` and the workflow's window — its `memory`'s
 * `uncompactedTurns`, else `DEFAULT_UNCOMPACTED_TURNS` (#1303).
 */
export function configDefaultsOf(
  defaults: WorkflowDefaults | undefined,
  uncompactedTurns: UncompactedTurns | undefined,
): AgentsConfig["defaults"] {
  return withoutUndefined({
    uncompactedTurns: uncompactedTurns ?? DEFAULT_UNCOMPACTED_TURNS,
    models: chatDefaultsOf(defaults?.models),
    router: defaults?.router === undefined ? undefined : routerModelOfId(defaults.router.model),
    tools: defaults?.tools,
  });
}

const modules = new WeakMap<Class, WorkflowMeta>();

/** A class's v2 `@Workflow` declaration; anything else is an error naming the fix. */
export function workflowDeclarationOf(workflow: Class): WorkflowDeclaration {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) {
    throw new ComponentError({
      message: `${workflow.name || "(anonymous class)"} is not a @Workflow class — decorate it with @Workflow({ name, version, flow })`,
    });
  }
  return declaration;
}

/** The module of a `@Workflow` class (cached per class). */
export function moduleOf(workflow: Class): WorkflowMeta {
  const cached = modules.get(workflow);
  if (cached !== undefined) return cached;
  const { options, source } = workflowDeclarationOf(workflow);
  const module: WorkflowMeta = withoutUndefined({
    type: workflow,
    name: options.name,
    version: options.version,
    source,
    defaults: configDefaultsOf(options.defaults, workflowWindowOf(options.memory)),
    piiPolicies: options.piiPolicies,
    excludePiiPolicies: options.excludePiiPolicies,
    guardrails: options.guardrails,
    toolInterceptors: options.toolInterceptors,
    excludeToolInterceptors: options.excludeToolInterceptors,
    memory: options.memory,
    providers: options.providers,
    services: options.services,
    promptVariables: options.promptVariables,
  });
  modules.set(workflow, module);
  return module;
}
