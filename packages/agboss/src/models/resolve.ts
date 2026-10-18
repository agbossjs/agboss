import type { ModelProviderHandler } from "./handler.js";
import {
  modelProviderOf,
  servesModel,
  type ModelProviderOptions,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import type { ModelProblem } from "./problems.js";

/** What a model is used for: a chat model (agents, compaction, LLM routers) or a decision (decision models). */
export enum ModelPurpose {
  Chat = "chat",
  Decision = "decision",
}

/** A registered provider: its options and its handler instance. */
export interface RegisteredModelProvider {
  readonly options: ModelProviderOptions;
  readonly handler: ModelProviderHandler;
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

const canServe = (provider: RegisteredModelProvider, purpose: ModelPurpose): boolean =>
  purpose === ModelPurpose.Chat
    ? provider.handler.chat !== undefined
    : provider.handler.routeTo !== undefined;

const names = (providers: readonly RegisteredModelProvider[]): string =>
  providers.map((provider) => provider.options.name).join(", ");

/**
 * The application's model providers (`@Application({ providers })`, #266) and who serves which
 * model: exactly one provider by `serves` (and the purpose it can serve) — a workflow or a
 * component never picks one.
 */
export class ModelProviderDirectory {
  constructor(readonly providers: readonly RegisteredModelProvider[]) {}

  /** Instantiates `@ModelProvider` classes (each constructed with no arguments). */
  static of(classes: readonly ModelProviderType[]): ModelProviderDirectory {
    return new ModelProviderDirectory(
      classes.map((cls) => ({
        options: modelProviderOf(cls),
        // a @ModelProvider class is constructed with no arguments (the decorator's type requires it)
        handler: new (cls as unknown as new () => ModelProviderHandler)(),
      })),
    );
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
