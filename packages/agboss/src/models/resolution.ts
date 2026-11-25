import type { AgentsConfigOf } from "../config/types.js";
import type { Provider } from "../components/injection.js";
import { guardrailReadersOf, type FileReader } from "../files/file-readers.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { ElementGuardrails } from "../guardrails/assembly.js";
import { modelGuardrailsOf, type LoadedGuardrail } from "../guardrails/loaded.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import {
  isDriverOptions,
  isModelProviderClass,
  hasProviderMethod,
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import { fallbackClassesOf } from "./fallback-chain.js";
import { ModelKind } from "./model-kind.js";
import {
  modelUsesOf,
  type ModelNamingComponents,
  type ModelNamingRouter,
  type ModelUse,
} from "./uses.js";
import type { ModelNamingInterpreter } from "./interpreter-uses.js";
import type { ProviderKinds } from "./use-purpose.js";
import { directoryOf } from "./workflow-models.js";

/**
 * Model providers are application infrastructure (#266): listed in `@Application({ providers })` or
 * named by a `modelProvider`, and every model of the application resolved to one of them through its
 * cascade — at assembly, before any model call.
 */

/** The `@ModelProvider` classes an application lists in its providers: none when it lists none. */
export const listedModelProvidersOf = (
  providers: readonly Provider[] | undefined,
): readonly ModelProviderType[] => (providers ?? []).filter(isModelProviderClass);

/** The `@ModelProvider` classes listed in an application's providers, and those a cascade names. */
export function modelProvidersOf(
  providers: readonly Provider[] | undefined,
  referenced: readonly ModelProviderType[] = [],
): readonly ModelProviderType[] {
  // a provider a cascade names is part of the application even when it is not listed (#1313)
  return [...new Set([...listedModelProvidersOf(providers), ...referenced])];
}

/**
 * The transport providers (#385) an application may call — listed, or a listed one's breaker
 * fallback: its container creates them, so their `deps` are checked with the components'.
 */
export const transportProviderClassesOf = (
  providers: readonly Provider[] | undefined,
): readonly ModelProviderType[] =>
  withFallbacks(modelProvidersOf(providers)).filter(isTransportClass);

/** Model provider classes and the fallbacks of their chains (`A → B → C`), each once. */
export function withFallbacks(classes: readonly ModelProviderType[]): readonly ModelProviderType[] {
  const fallbacks = fallbackClassesOf(classes).filter(isModelProviderClass);
  return [...new Set([...classes, ...fallbacks])];
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
  /** Its PII policies' model detections (#120), by policy `name` and `model`. */
  readonly pii?: { readonly detectors: readonly ModelNamingRouter[] };
  /** Its reply interpreters (#267 PR 3), by `name` and `model` (none for a code one). */
  readonly replyInterpreters?: readonly ModelNamingInterpreter[];
  /** Its guardrails (#120): the model ones by `name` and `model`, a code one (#383) names none. */
  readonly guardrails?: {
    readonly guardrails: readonly LoadedGuardrail[];
    /** Each agent's and router's guardrails by side: which files each model reads (#899 §8). */
    readonly byElement?: ReadonlyMap<string, ElementGuardrails>;
  };
  /** The graph: which agents answer with files (#899 §8). */
  readonly graph?: Pick<RuntimeGraph, "nodes">;
  /** Its knowledge bases' model rerankers (#703), by `name` and `model`. */
  readonly rerankers?: readonly ModelNamingRouter[];
  /** The application lists its own `FileTranscriber` (#899): the built-in's model is no use then. */
  readonly ownFileTranscriber?: unknown;
  /** The application lists its own `FileRedactor` (#899): the built-in's model is no use then. */
  readonly ownFileRedactor?: unknown;
  readonly modelProviders: readonly ModelProviderType[];
  /**
   * Before `modelProviders` is known: the `@ModelProvider` classes the cascade names, whose drivers
   * say what kind of model a use is (#1313).
   */
  readonly referencedProviders?: readonly ModelProviderType[];
}

/** What each provider speaks, by its `name`: a driver's kind; a custom class that only decides is a decisions one. */
export function providerKindsOf(classes: readonly ModelProviderType[]): ProviderKinds {
  return new Map(
    classes.map((cls) => {
      const options = modelProviderOf(cls);
      if (isDriverOptions(options)) return [options.name, options.driver.kind] as const;
      const decides = hasProviderMethod(cls, "decide") && !isTransportClass(cls);
      return [options.name, decides ? ModelKind.Decisions : ModelKind.Chat] as const;
    }),
  );
}

/**
 * Every model use of a workflow's models: the one place they are listed from, for the graph rules,
 * `check --models` and the providers connected at start (#716) alike.
 */
export function workflowModelUsesOf(
  workflow: Omit<WorkflowModels, "modelProviders"> & {
    readonly modelProviders?: readonly ModelProviderType[];
  },
): readonly ModelUse[] {
  // `satisfies`: a component added to `ModelNamingComponents` and not passed here fails to compile
  const components = {
    arbiters: workflow.arbiters,
    piiDetectors: workflow.pii?.detectors,
    interpreters: workflow.replyInterpreters,
    guardrails: guardrailUsesOf(workflow),
    rerankers: workflow.rerankers,
    builtInFileModels: workflow.ownFileTranscriber === undefined,
    builtInFileRedactor: workflow.ownFileRedactor === undefined,
  } satisfies Record<keyof ModelNamingComponents, unknown>;
  const kinds = providerKindsOf(workflow.modelProviders ?? workflow.referencedProviders ?? []);
  return modelUsesOf(workflow.config, workflow.routers, components, kinds);
}

/** The model guardrails with what each reads of the agents' files (#899 §8). */
function guardrailUsesOf(
  workflow: Omit<WorkflowModels, "modelProviders">,
): readonly ModelNamingRouter[] {
  const readers =
    workflow.guardrails?.byElement === undefined || workflow.graph === undefined
      ? new Map<string, FileReader>()
      : guardrailReadersOf(workflow.config, workflow.guardrails.byElement, workflow.graph);
  return modelGuardrailsOf(workflow.guardrails).map((guardrail) => ({
    name: guardrail.name,
    model: guardrail.model,
    modelProvider: guardrail.modelProvider,
    reads: readers.get(guardrail.name),
  }));
}

type ResolutionRule = "model.missing-provider" | "model.incompatible-provider";

/** The rule a directory problem is reported as. */
const ruleOf = (code: string): ResolutionRule =>
  code === "model.incompatible-provider" ? code : "model.missing-provider";

const FIX: Readonly<Record<ResolutionRule, string>> = {
  "model.missing-provider":
    "set modelProvider on the component, its @Workflow or its @Application, and list the provider in @Application({ providers })",
  "model.incompatible-provider":
    "a chat model needs a provider with a chat driver (OpenAiCompatibleDriver, OpenRouterDriver) or a transport, a decision model one with DecisionsDriver",
};

/** `[model.missing-provider]` / `[model.incompatible-provider]` for every model use no listed provider serves. */
function modelResolutionViolations(workflow: WorkflowModels): RuleViolation[] {
  const directory = directoryOf(workflow.modelProviders);
  return workflowModelUsesOf(workflow).flatMap((use) => {
    const resolution = directory.resolve(use);
    if (resolution.kind === "resolved") return [];
    const { code, supported } = resolution.problem;
    return [
      violation(
        ruleOf(code),
        `${workflow.config.name} ${use.key} = ${use.model}: ${supported} — ${FIX[ruleOf(code)]}`,
        [workflow.config.name],
      ),
    ];
  });
}

/**
 * A workflow's models once more, after a profile changed them (#895): the models a profile names
 * are resolved as the assembly resolves them, `[model.missing-provider]` at assembly, not on the first call.
 */
export function checkModelsServed(
  workflow: Pick<WorkflowModels, "config" | "routers" | "modelProviders">,
): void {
  const found = modelResolutionViolations(workflow);
  if (found.length > 0) throw new GraphRuleError({ violations: found });
}

/**
 * The model providers of a workflow — its application's (`providers`) and those its cascade names — with
 * every model of it resolved to one of them; one that is not fails the workflow's assembly.
 */
export function resolvedModelProvidersOf(
  listed: readonly Provider[] | undefined,
  workflow: Omit<WorkflowModels, "modelProviders">,
  referenced: readonly ModelProviderType[] = [],
): readonly ModelProviderType[] {
  const modelProviders = modelProvidersOf(listed, referenced);
  const found = modelResolutionViolations({
    ...workflow,
    modelProviders,
    referencedProviders: referenced,
  });
  if (found.length > 0) throw new GraphRuleError({ violations: found });
  return modelProviders;
}

/**
 * Every model use of an application's workflows (`agboss check --models`, #266): each key prefixed
 * with its workflow's name when the application has several.
 */
export function applicationModelUsesOf(workflows: readonly WorkflowModels[]): readonly ModelUse[] {
  const several = workflows.length > 1;
  return workflows.flatMap((workflow) =>
    workflowModelUsesOf(workflow).map((use) =>
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
  return workflowModelUsesOf(workflow).map((use) => {
    const resolution = directory.resolve(use);
    const provider =
      resolution.kind === "resolved" ? resolution.provider.options.name : resolution.problem.code;
    return { key: use.key, model: use.model, provider };
  });
}

/** `agents.scout-agent  model: moonshotai/kimi-k2.6 → openrouter`. */
export const modelProviderLine = (use: ResolvedModelUse): string =>
  `${use.key}  model: ${use.model} → ${use.provider}`;
