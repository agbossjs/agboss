import { driverHandlerOf, type ModelDriver } from "./model-driver.js";
import type { ModelProviderHandler, ProviderHandler } from "./handler.js";
import {
  hasProviderMethod,
  isTransportClass,
  modelProviderOf,
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
  readonly handler: ProviderHandler | undefined;
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
   * its application's), by `name` (#1313). Absent: no provider serves it (`[model.missing-provider]`).
   */
  readonly modelProvider?: string | undefined;
}

/** What the provider can serve: a driver says it; for a custom class its methods do (`complete` is a chat model, `decide` a decision one). */
const canServe = (provider: RegisteredModelProvider, purpose: ModelKind): boolean => {
  const { driver } = driverOf(provider);
  if (driver !== undefined) return driver.kind === purpose;
  return purpose === ModelKind.Chat
    ? hasProviderMethod(provider.type, "complete")
    : hasProviderMethod(provider.type, "decide");
};

/** The provider's driver, when it is a driver provider (#1313). */
const driverOf = (
  provider: RegisteredModelProvider,
): { readonly driver: ModelDriver | undefined } => ({
  driver: isDriverOptions(provider.options) ? provider.options.driver : undefined,
});

const names = (providers: readonly RegisteredModelProvider[]): string =>
  providers.map((provider) => provider.options.name).join(", ");

/** A provider class as registered: a driver's handler, a transport not yet (the container creates it). */
export function registeredOf(cls: ModelProviderType): RegisteredModelProvider {
  const options = modelProviderOf(cls);
  return {
    options,
    type: cls,
    // a driver provider's handler is its driver's (#1313); a transport provider's is made by the container
    handler: isDriverOptions(options)
      ? driverHandlerOf(options.driver)
      : isTransportClass(cls)
        ? undefined
        : handlerOf(cls),
  };
}

/** A custom provider class without `complete`: constructed with no arguments (all its members are optional). */
function handlerOf(cls: ModelProviderType): ModelProviderHandler {
  const made: unknown = Reflect.construct(cls, []);
  return typeof made === "object" && made !== null ? made : {};
}

/**
 * The application's model providers (`@Application({ providers })`, #266) and which serves a model
 * use: the one its cascade names (`modelProvider`: the component's, its workflow's or its
 * application's) — there is no routing by a model's name.
 */
export class ModelProviderDirectory {
  constructor(readonly providers: readonly RegisteredModelProvider[]) {}

  /** The `@ModelProvider` classes, each registered. */
  static of(classes: readonly ModelProviderType[]): ModelProviderDirectory {
    return new ModelProviderDirectory(classes.map(registeredOf));
  }

  /** The one provider of this `name`; none when no provider, or more than one, has it (`[model.duplicate-provider-name]`). */
  named(name: string): RegisteredModelProvider | undefined {
    const named = this.providers.filter((candidate) => candidate.options.name === name);
    return named.length === 1 ? named[0] : undefined;
  }

  /**
   * The provider a model use goes to: the cascade's (`query.modelProvider`), which must be listed
   * and speak the purpose's protocol. A use whose cascade names none is `[model.missing-provider]`.
   */
  resolve(query: ProviderQuery): ProviderResolution {
    const problem = (code: ModelProblem["code"], supported: string): ProviderResolution => ({
      kind: "problem",
      problem: { code, key: query.key, value: query.model, model: query.model, supported },
    });
    if (query.modelProvider === undefined)
      return problem(
        "model.missing-provider",
        `no modelProvider is set for it — name one on the component, its workflow or its application (listed: ${names(this.providers)})`,
      );
    const name = query.modelProvider;
    const named = this.providers.filter((candidate) => candidate.options.name === name);
    const [provider] = named;
    if (provider === undefined)
      return problem(
        "model.missing-provider",
        `modelProvider ${name} is not listed in @Application({ providers }) (listed: ${names(this.providers)})`,
      );
    // two classes of one name: the call would reach either's upstream with either's key — never guess
    if (named.length > 1)
      return problem(
        "model.duplicate-provider-name",
        `${String(named.length)} model providers are named ${name} (${named.map((one) => one.type.name).join(", ")}) — give each its own name`,
      );
    if (!canServe(provider, query.purpose))
      return problem(
        "model.incompatible-provider",
        `${name} does not serve ${query.purpose} models`,
      );
    return { kind: "resolved", provider };
  }
}
