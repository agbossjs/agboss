import { isDeepStrictEqual } from "node:util";
import {
  InjectionToken,
  isClassProvider,
  tokenName,
  type Class,
  type Provider,
  type Token,
} from "../injection.js";
import { ComponentError } from "../metadata.js";

/**
 * What the one container of an application instance holds (#261): the providers of every workflow,
 * one registration per token. A class is found by inheritance — a dependency on a contract gets the
 * one registered class that is it or extends it.
 */

/** One list of providers and who lists it (a workflow's or the application's name), for the messages. */
export interface ProviderModule {
  readonly owner: string;
  readonly providers: readonly Provider[];
  /** The decorator that lists them (default `@Workflow`). */
  readonly declaredIn?: "@Workflow" | "@Application";
}

/** `@Workflow "desk-workflow"` / `@Application "desk-application"`. */
const ownerOf = (module: ProviderModule): string =>
  `${module.declaredIn ?? "@Workflow"} "${module.owner}"`;

/** What a token resolves to: a value, or a class the container creates (one instance per class). */
export type Registration =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "class"; readonly cls: Class };

/** Whether `cls` is `contract` or extends it. */
const implementsContract = (cls: Class, contract: Class): boolean =>
  cls === contract || Object.prototype.isPrototypeOf.call(contract.prototype, cls.prototype);

/** Values must come with an `InjectionToken`: a class is listed and created by the container. */
function checkValueToken(token: Token, owner: string): void {
  if (token instanceof InjectionToken) return;
  throw new ComponentError(
    `[di.instance-provider] ${owner}: provide(${tokenName(token)}, …) binds an instance to a class — list ${tokenName(token)} in providers and let the container create it; values go with an InjectionToken`,
  );
}

const conflictingValues = (token: Token, first: string, second: string): ComponentError =>
  new ComponentError(
    first === second
      ? `[di.conflicting-values] ${tokenName(token)} has two different values in ${first} — keep one`
      : `[di.conflicting-values] ${tokenName(token)} has different values in ${first} and ${second} — use different tokens or an environment value`,
  );

/** The registrations of an application instance: the core values, then every module's providers. */
export class Registrations {
  readonly #values = new Map<Token, unknown>();
  readonly #valueOwners = new Map<Token, string>();
  readonly #classes = new Map<Class, string>();
  readonly #replacements = new Map<Class, Class>();
  /** A class for a token (#891: `provide(EXECUTION_ID_STORE, Class)`): found under that token only. */
  readonly #tokenClasses = new Map<Token, Class>();

  constructor(
    modules: readonly ProviderModule[],
    core: ReadonlyMap<Token, unknown>,
    private readonly defaults: ReadonlyMap<Class, Class> = new Map(),
  ) {
    for (const [token, value] of core) this.#values.set(token, value);
    for (const module of modules) {
      const owner = ownerOf(module);
      for (const provider of module.providers) {
        if (isClassProvider(provider)) this.#addClass(provider.provide, provider.useClass, owner);
        else if ("provide" in provider) this.#addValue(provider.provide, provider.useValue, owner);
        else if (!this.#classes.has(provider)) this.#classes.set(provider, owner);
      }
    }
  }

  #addValue(token: Token, value: unknown, owner: string): void {
    checkValueToken(token, owner);
    const first = this.#valueOwners.get(token);
    const isConflict =
      this.#tokenClasses.has(token) || !isDeepStrictEqual(this.#values.get(token), value);
    if (first !== undefined && isConflict) {
      throw conflictingValues(token, first, owner);
    }
    this.#values.set(token, value);
    this.#valueOwners.set(token, first ?? owner);
  }

  #addClass(token: Token, cls: Class, owner: string): void {
    const first = this.#valueOwners.get(token);
    if (first !== undefined && this.#tokenClasses.get(token) !== cls) {
      throw conflictingValues(token, first, owner);
    }
    this.#tokenClasses.set(token, cls);
    this.#valueOwners.set(token, first ?? owner);
  }

  /** Replaces what tokens resolve to (test mocks): values win over every registration. */
  override(values: ReadonlyMap<Token, unknown>): void {
    for (const [token, value] of values) this.#values.set(token, value);
  }

  /** Classes created instead of others (test overrides): over every listed class, under values. */
  replace(replacements: ReadonlyMap<Class, Class>): void {
    for (const [token, replacement] of replacements) this.#replacements.set(token, replacement);
  }

  /** The listed classes, in the order they were listed (each once). */
  get classes(): readonly Class[] {
    return [...this.#classes.keys()];
  }

  /**
   * What `token` resolves to: its value; else the one listed class that is it or extends it; else the
   * framework's default implementation of the contract; `undefined` when nothing is registered. Two
   * listed implementations → `[di.ambiguous-implementation]`, naming `dependant`.
   */
  find(token: Token, dependant: string): Registration | undefined {
    if (this.#values.has(token)) return { kind: "value", value: this.#values.get(token) };
    const tokenClass = this.#tokenClasses.get(token);
    if (tokenClass !== undefined) return this.#resolvedClass(tokenClass);
    if (token instanceof InjectionToken) return undefined;
    const replacement = this.#replacements.get(token);
    if (replacement !== undefined) return { kind: "class", cls: replacement };
    const found = this.classes.filter((cls) => implementsContract(cls, token));
    if (found.length > 1) throw this.#ambiguous(token, found, dependant);
    const cls = found[0] ?? this.defaults.get(token);
    if (cls === undefined) return undefined;
    return this.#resolvedClass(cls);
  }

  /**
   * What a class found for a token resolves to: a test's mock of that class too, and its
   * replacement (#890: `override(SqliteFencedEffectRepository, …)` reaches `FencedEffects`).
   */
  #resolvedClass(cls: Class): Registration {
    if (this.#values.has(cls)) return { kind: "value", value: this.#values.get(cls) };
    return { kind: "class", cls: this.#replacements.get(cls) ?? cls };
  }

  #ambiguous(contract: Class, found: readonly Class[], dependant: string): ComponentError {
    const listed = found
      .map((cls) => `${tokenName(cls)} (${this.#classes.get(cls) ?? ""})`)
      .join(", ");
    return new ComponentError(
      `[di.ambiguous-implementation] ${dependant} depends on ${tokenName(contract)}, and ${String(found.length)} listed classes implement it: ${listed} — list one`,
    );
  }
}
