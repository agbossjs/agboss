/** A named value to inject (config objects, functions); classes are their own tokens. */
export class InjectionToken<T> {
  declare readonly __type: T;
  constructor(readonly description: string) {}
}

/** Any class. `never[]` parameters: we only need the instance type. */
export type Class<T = unknown> = abstract new (...args: never[]) => T;

export type Token = Class | InjectionToken<unknown>;

/** What a token gives the constructor: a token's value type, or a class's instance type. */
export type Resolved<T> =
  T extends InjectionToken<infer V>
    ? V
    : T extends abstract new (...args: never[]) => infer I
      ? I
      : never;

/** Constructor parameters for a `deps` list — the compiler checks count, order and types. */
export type ResolvedAll<D extends readonly Token[]> = { -readonly [K in keyof D]: Resolved<D[K]> };

export const tokenName = (token: Token): string =>
  token instanceof InjectionToken ? token.description : token.name || "(anonymous class)";

/** Module-private: only `provide()` can build a `ValueProvider` or a `ClassProvider`, so a raw literal is a type error. */
const valueProviderBrand: unique symbol = Symbol("ValueProvider");
const classProviderBrand: unique symbol = Symbol("ClassProvider");

/** A value bound to a token; build it with `provide(token, value)`. */
export interface ValueProvider<T = unknown> {
  readonly provide: InjectionToken<T> | Class<T>;
  readonly useValue: T;
  readonly [valueProviderBrand]: true;
}

/**
 * A class the container creates for a token (#891); build it with `provide(TOKEN, Class)`. The
 * class is registered under the token only: a dependency on a contract it extends never finds it
 * there (`provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)` is no second lease
 * store), and the instance is the container's one of that class.
 */
export interface ClassProvider<T = unknown> {
  /** The token the class is created for. */
  readonly provide: InjectionToken<T>;
  /** The class the container creates, its own `deps` injected. */
  readonly useClass: Class<T>;
  /** Only `provide()` builds one: a raw literal does not compile. */
  readonly [classProviderBrand]: true;
}

/** Registered in `@Workflow({ providers })`: a class (created by the container), a value, or a class for a token. */
export type Provider = Class | ValueProvider | ClassProvider;

/** Whether `value` is a class (`class X {}`), not a plain function or an arrow. */
const isClassValue = (value: unknown): value is Class =>
  typeof value === "function" && /^class[\s{]/u.test(Function.prototype.toString.call(value));

/** `provide(TOKEN, Class)`: the container creates the class for the token (#891). */
export function provide<T>(token: InjectionToken<T>, cls: Class<T>): ClassProvider<T>;
/**
 * `provide(token, value)`: the value, tied strictly to its token's type — never a class, which
 * `provide(TOKEN, Class)` gives the container to create.
 */
export function provide<T>(
  token: InjectionToken<T> | Class<T>,
  value: T extends abstract new (...args: never[]) => unknown ? never : T,
): ValueProvider<T>;
export function provide<T>(
  token: InjectionToken<T> | Class<T>,
  value: T | Class<T>,
): ValueProvider<T> | ClassProvider<T> {
  if (token instanceof InjectionToken && isClassValue(value))
    return { provide: token, useClass: value as Class<T>, [classProviderBrand]: true };
  return { provide: token, useValue: value as T, [valueProviderBrand]: true };
}

/** Whether a provider is a class for a token (`provide(TOKEN, Class)`). */
export const isClassProvider = (provider: Provider): provider is ClassProvider =>
  typeof provider === "object" && "useClass" in provider;

/** The classes the container creates for `providers`: the listed ones and those given for a token. */
export const createdClassesOf = (providers: readonly Provider[]): readonly Class[] =>
  providers.flatMap((provider) => {
    if (typeof provider === "function") return [provider];
    return isClassProvider(provider) ? [provider.useClass] : [];
  });
