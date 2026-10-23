import type { ModelProviderHandler } from "./handler.js";
import {
  hasProviderMethod,
  isTransportClass,
  modelProviderOf,
  servesModel,
  type KeptModelProviderOptions,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import type { ModelProblem } from "./problems.js";

/** What a model is used for: a chat model (agents, compaction, LLM routers) or a decision (decision models). */
export enum ModelPurpose {
  Chat = "chat",
  Decision = "decision",
}

/**
 * A registered provider: its options, its class and, for an HTTP provider, its instance — a
 * transport provider (#385) has none here: the application's container creates it on first use.
 */
export interface RegisteredModelProvider {
  readonly options: KeptModelProviderOptions;
  readonly type: ModelProviderType;
  readonly handler: ModelProviderHandler | undefined;
}

/** Which provider serves a model, or why none can. */
export type ProviderResolution =
  | { readonly kind: "resolved"; readonly provider: RegisteredModelProvider }
  | { readonly kind: "problem"; readonly problem: ModelProblem };

/** A model's use the directory resolves: the setting's key, the model, its purpose. */
export interface ProviderQuery {
  readonly key: string;
  readonly model: string;
  readonly purpose: ModelPurpose;
}

/** What the class can serve, read from its methods (a transport's `complete` is a chat model). */
const canServe = (provider: RegisteredModelProvider, purpose: ModelPurpose): boolean =>
  purpose === ModelPurpose.Chat
    ? hasProviderMethod(provider.type, "chat") || hasProviderMethod(provider.type, "complete")
    : hasProviderMethod(provider.type, "routeTo");

const names = (providers: readonly RegisteredModelProvider[]): string =>
  providers.map((provider) => provider.options.name).join(", ");

/** A provider class as registered: an HTTP one constructed with no arguments, a transport not yet. */
export function registeredOf(cls: ModelProviderType): RegisteredModelProvider {
  return {
    options: modelProviderOf(cls),
    type: cls,
    handler: isTransportClass(cls)
      ? undefined
      : // an HTTP @ModelProvider class takes no arguments (the decorator's overload requires it)
        new (cls as unknown as new () => ModelProviderHandler)(),
  };
}

/**
 * The application's model providers (`@Application({ providers })`, #266) and who serves which
 * model: exactly one provider by `serves` (and the purpose it can serve) — a workflow or a
 * component never picks one.
 */
export class ModelProviderDirectory {
  constructor(readonly providers: readonly RegisteredModelProvider[]) {}

  /** The `@ModelProvider` classes, each registered (an HTTP one constructed with no arguments). */
  static of(classes: readonly ModelProviderType[]): ModelProviderDirectory {
    return new ModelProviderDirectory(classes.map(registeredOf));
  }

  /** The one provider serving the model for its purpose; none or several is a problem. */
  resolve(query: ProviderQuery): ProviderResolution {
    const serving = this.providers.filter(
      (provider) => servesModel(provider.options, query.model) && canServe(provider, query.purpose),
    );
    const problem = (code: ModelProblem["code"], supported: string): ProviderResolution => ({
      kind: "problem",
      problem: { code, key: query.key, value: query.model, model: query.model, supported },
    });
    const [only, ...others] = serving;
    if (only === undefined)
      return problem(
        "model.unserved",
        `no listed provider serves it for ${query.purpose} (listed: ${names(this.providers)})`,
      );
    if (others.length === 0) return { kind: "resolved", provider: only };
    return problem("model.ambiguous-provider", `served by several providers: ${names(serving)}`);
  }
}
