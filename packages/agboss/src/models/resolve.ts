import { isCatchAllProvider } from "./catch-all.js";
import type { ModelDriver } from "./model-driver.js";
import type { ModelProviderHandler } from "./handler.js";
import {
  hasProviderMethod,
  isTransportClass,
  modelProviderOf,
  servesModel,
  type KeptModelProviderOptions,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import { isDriverOptions } from "./model-provider.decorator.js";
import { ModelKind } from "./model-kind.js";
import type { ModelProblem } from "./problems.js";

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
  readonly purpose: ModelKind;
  /**
   * The provider its component's cascade names (`modelProvider`: the component's, its workflow's or
   * its application's), by `name` (#1313). Absent: the older providers' `serves` patterns decide.
   */
  readonly modelProvider?: string | undefined;
}

/** What the provider can serve: a driver says it; for the older ones the class's methods do (a transport's `complete` is a chat model). */
const canServe = (provider: RegisteredModelProvider, purpose: ModelKind): boolean => {
  const { driver } = driverOf(provider);
  if (driver !== undefined) return driver.kind === purpose;
  return purpose === ModelKind.Chat
    ? hasProviderMethod(provider.type, "chat") || hasProviderMethod(provider.type, "complete")
    : hasProviderMethod(provider.type, "decide") || hasProviderMethod(provider.type, "routeTo");
};

/** The provider's driver, when it is a driver provider (#1313). */
const driverOf = (
  provider: RegisteredModelProvider,
): { readonly driver: ModelDriver | undefined } => ({
  driver: isDriverOptions(provider.options) ? provider.options.driver : undefined,
});

/** Whether the provider is a driver provider: reached through `modelProvider`, never by a model's name. */
export const isDriverProvider = (provider: RegisteredModelProvider): boolean =>
  driverOf(provider).driver !== undefined;

const names = (providers: readonly RegisteredModelProvider[]): string =>
  providers.map((provider) => provider.options.name).join(", ");

/** An HTTP provider's handler: its class constructed with no arguments (all its members are optional). */
function handlerOf(cls: ModelProviderType): ModelProviderHandler {
  const made: unknown = Reflect.construct(cls, []);
  return typeof made === "object" && made !== null ? made : {};
}

/** A provider class as registered: an HTTP one constructed with no arguments, a transport not yet. */
export function registeredOf(cls: ModelProviderType): RegisteredModelProvider {
  const options = modelProviderOf(cls);
  return {
    options,
    type: cls,
    // a driver provider's handler is its driver's (#1313); a transport provider's is made by the container
    handler: isDriverOptions(options)
      ? options.driver.handler
      : isTransportClass(cls)
        ? undefined
        : // an HTTP @ModelProvider class takes no arguments (the decorator's overload requires it)
          handlerOf(cls),
  };
}

/**
 * The providers that serve a model: a built-in catch-all (#454) only when no other of them claims
 * it — an explicit `serves` wins over the catch-all, two explicit claims stay ambiguous.
 */
function claimantsOf(serving: readonly RegisteredModelProvider[]): RegisteredModelProvider[] {
  const explicit = serving.filter((provider) => !isCatchAllProvider(provider.type));
  return explicit.length === 0 ? [...serving] : explicit;
}

/**
 * The application's model providers (`@Application({ providers })`, #266) and who serves which
 * model: exactly one provider by `serves` (and the purpose it can serve) — a built-in catch-all
 * yields to a provider that claims the model (#454); a workflow or a component never picks one.
 */
export class ModelProviderDirectory {
  constructor(readonly providers: readonly RegisteredModelProvider[]) {}

  /** The `@ModelProvider` classes, each registered (an HTTP one constructed with no arguments). */
  static of(classes: readonly ModelProviderType[]): ModelProviderDirectory {
    return new ModelProviderDirectory(classes.map(registeredOf));
  }

  /**
   * The provider a model use goes to. The cascade's provider (`query.modelProvider`) when the
   * component, its workflow or its application names one — it must be listed and speak the
   * purpose's protocol; otherwise the one provider serving the model by `serves`; none or several
   * is a problem.
   */
  resolve(query: ProviderQuery): ProviderResolution {
    if (query.modelProvider !== undefined) return this.named(query, query.modelProvider);
    const serving = claimantsOf(
      this.providers.filter(
        (provider) =>
          servesModel(provider.options, query.model) && canServe(provider, query.purpose),
      ),
    );
    const problem = (code: ModelProblem["code"], supported: string): ProviderResolution => ({
      kind: "problem",
      problem: { code, key: query.key, value: query.model, model: query.model, supported },
    });
    const [only, ...others] = serving;
    if (only === undefined && this.providers.some(isDriverProvider))
      return problem(
        "model.missing-provider",
        `no modelProvider is set for it — name one on the component, its workflow or its application (listed: ${names(this.providers)})`,
      );
    if (only === undefined)
      return problem(
        "model.unserved",
        `no listed provider serves it for ${query.purpose} (listed: ${names(this.providers)})`,
      );
    if (others.length === 0) return { kind: "resolved", provider: only };
    return problem("model.ambiguous-provider", `served by several providers: ${names(serving)}`);
  }

  /** The provider the cascade names, by its `name`: listed and of the purpose's kind. */
  private named(query: ProviderQuery, name: string): ProviderResolution {
    const problem = (code: ModelProblem["code"], supported: string): ProviderResolution => ({
      kind: "problem",
      problem: { code, key: query.key, value: query.model, model: query.model, supported },
    });
    const provider = this.providers.find((candidate) => candidate.options.name === name);
    if (provider === undefined)
      return problem(
        "model.missing-provider",
        `modelProvider ${name} is not listed in @Application({ providers }) (listed: ${names(this.providers)})`,
      );
    if (!canServe(provider, query.purpose))
      return problem(
        "model.incompatible-provider",
        `${name} does not serve ${query.purpose} models`,
      );
    return { kind: "resolved", provider };
  }
}
