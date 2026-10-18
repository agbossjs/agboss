import type { AgentsConfigOf } from "../config/types.js";
import type { Provider } from "../components/injection.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import { isModelProviderClass, type ModelProviderType } from "./model-provider.decorator.js";
import { modelUsesOf, type ModelNamingRouter, type ModelUse } from "./uses.js";
import { DEFAULT_MODEL_PROVIDERS, directoryOf } from "./workflow-models.js";

/**
 * Model providers are application infrastructure (#266): listed only in `@Application({ providers })`,
 * the built-ins only when none is listed, and every model of the application resolved to exactly one
 * of them by `serves` — at assembly, before any model call.
 */

/** The `@ModelProvider` classes listed in an application's providers, else the built-ins. */
export function modelProvidersOf(
  providers: readonly Provider[] | undefined,
): readonly ModelProviderType[] {
  const listed = (providers ?? []).filter(isModelProviderClass);
  return listed.length === 0 ? DEFAULT_MODEL_PROVIDERS : listed;
}

/** An application's providers without its model providers: what its container creates. */
export const containerProvidersOf = (providers: readonly Provider[] | undefined): Provider[] =>
  (providers ?? []).filter((provider) => !isModelProviderClass(provider));

/** What a workflow's models are read from: its config, its routers and its application's providers. */
export interface WorkflowModels {
  readonly config: AgentsConfigOf<string>;
  readonly routers: readonly ModelNamingRouter[];
  /** Its model arbiters (#279), by `name` and `model`. */
  readonly arbiters?: readonly ModelNamingRouter[];
  readonly modelProviders: readonly ModelProviderType[];
}

/** `[model.unserved]` / `[model.ambiguous-provider]` for every model use no single provider serves. */
function modelResolutionViolations(workflow: WorkflowModels): RuleViolation[] {
  const directory = directoryOf(workflow.modelProviders);
  return modelUsesOf(workflow.config, workflow.routers, workflow.arbiters).flatMap((use) => {
    const resolution = directory.resolve(use);
    if (resolution.kind === "resolved") return [];
    const { code, supported } = resolution.problem;
    const fix =
      code === "model.unserved"
        ? "list a @ModelProvider that serves it in @Application({ providers })"
        : "one model string per provider, each in one serves";
    return [
      violation(
        code === "model.unserved" ? "model.unserved" : "model.ambiguous-provider",
        `${workflow.config.name} ${use.key} = ${use.model}: ${supported} — ${fix}`,
        [workflow.config.name],
      ),
    ];
  });
}

/**
 * The model providers of a workflow — its application's (`providers`), else the built-ins — with
 * every model of it resolved to one of them; one that is not fails the workflow's assembly.
 */
export function resolvedModelProvidersOf(
  listed: readonly Provider[] | undefined,
  workflow: Omit<WorkflowModels, "modelProviders">,
): readonly ModelProviderType[] {
  const modelProviders = modelProvidersOf(listed);
  const found = modelResolutionViolations({ ...workflow, modelProviders });
  if (found.length > 0) throw new GraphRuleError(found);
  return modelProviders;
}

/**
 * Every model use of an application's workflows (`agboss check --models`, #266): each key prefixed
 * with its workflow's name when the application has several.
 */
export function applicationModelUsesOf(workflows: readonly WorkflowModels[]): readonly ModelUse[] {
  const several = workflows.length > 1;
  return workflows.flatMap((workflow) =>
    modelUsesOf(workflow.config, workflow.routers, workflow.arbiters).map((use) =>
      several ? { ...use, key: `${workflow.config.name} ${use.key}` } : use,
    ),
  );
}

/** A model use with the provider it resolves to (`agboss describe`). */
export interface ResolvedModelUse {
  readonly key: string;
  readonly model: string;
  /** The provider's name; the problem's code when none or several serve it. */
  readonly provider: string;
}

/** Each model use of a workflow with its provider's name — though no component names one. */
export function resolvedModelUsesOf(workflow: WorkflowModels): readonly ResolvedModelUse[] {
  const directory = directoryOf(workflow.modelProviders);
  return modelUsesOf(workflow.config, workflow.routers, workflow.arbiters).map((use) => {
    const resolution = directory.resolve(use);
    const provider =
      resolution.kind === "resolved" ? resolution.provider.options.name : resolution.problem.code;
    return { key: use.key, model: use.model, provider };
  });
}

/** `agents.scout-agent  model: moonshotai/kimi-k2.6 → openrouter`. */
export const modelProviderLine = (use: ResolvedModelUse): string =>
  `${use.key}  model: ${use.model} → ${use.provider}`;
