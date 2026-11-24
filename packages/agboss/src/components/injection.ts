import type { EnvContract, InferEnv } from "../environments/env-ref.js";

/** A named value to inject (config objects, functions); classes are their own tokens. */
export class InjectionToken<T> {
  declare readonly __type: T;
  constructor(readonly description: string) {}
}

/** Any class. `never[]` parameters: we only need the instance type. */
export type Class<T = unknown> = abstract new (...args: never[]) => T;

/** What `deps` takes: a class, a named value, or a `defineEnv` dictionary (its resolved values, #1324). */
export type Token = Class | InjectionToken<unknown> | EnvContract;

/** What a token gives the constructor: a token's value type, or a class's instance type. */
export type Resolved<T> =
  T extends InjectionToken<infer V>
    ? V
    : T extends abstract new (...args: never[]) => infer I
      ? I
      : T extends EnvContract
        ? InferEnv<T>
        : never;

/** Constructor parameters for a `deps` list — the compiler checks count, order and types. */
export type ResolvedAll<D extends readonly Token[]> = { -readonly [K in keyof D]: Resolved<D[K]> };

export const tokenName = (token: Token): string => {
  if (token instanceof InjectionToken) return token.description;
  if (typeof token === "function") return token.name || "(anonymous class)";
  return `defineEnv({ ${Object.keys(token).join(", ")} })`;
};

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
export function provide<T>(token: InjectionToken<T>, cls: Class<NoInfer<T>>): ClassProvider<T>;
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
    return { provide: token, useClass: value, [classProviderBrand]: true };
  return { provide: token, useValue: value as T, [valueProviderBrand]: true };
}

/**
 * What `services` takes (#1324): a class the container creates (an `@Injectable`, `@McpServer` or
 * `@A2AAgent`, bound to the ports its `injectAs` names), or a value bound with `provide(TOKEN, value)`.
 * A class for a token (`provide(TOKEN, Class)`) is no service: it is `injectAs`.
 */
export type ServiceEntry = Class | ValueProvider;

/** Whether a provider is a class for a token (`provide(TOKEN, Class)`). */
export const isClassProvider = (provider: Provider): provider is ClassProvider =>
  typeof provider === "object" && "useClass" in provider;

/** The classes the container creates for `providers`: the listed ones and those given for a token. */
export const createdClassesOf = (providers: readonly Provider[]): readonly Class[] =>
  providers.flatMap((provider) => {
    if (typeof provider === "function") return [provider];
    return isClassProvider(provider) ? [provider.useClass] : [];
  });

/**
 * The abstract ports a class is the implementation of (#1324): `@Injectable({ injectAs: Port })`,
 * `@McpServer({ injectAs })`, `@A2AAgent({ injectAs })`. A dependency on a port gets the one listed
 * class that extends it or names it here; a workflow's own `services` shadow the application's.
 */
const injected = new WeakMap<Class, readonly Class[]>();

/** What `injectAs` takes: one port, or several. */
export type InjectAs = Class | readonly Class[];

/** The ports as a list. */
export const portsOf = (injectAs: InjectAs | undefined): readonly Class[] =>
  injectAs === undefined
    ? []
    : Array.isArray(injectAs)
      ? [...(injectAs as readonly Class[])]
      : [injectAs as Class];

/** Remembers the ports a class is the implementation of. */
export function recordInjectAs(cls: Class, injectAs: InjectAs | undefined): void {
  const ports = portsOf(injectAs);
  if (ports.length > 0) injected.set(cls, ports);
}

/** The ports `cls` names with `injectAs`; none for a class that names none. */
export const injectAsOf = (cls: Class): readonly Class[] => injected.get(cls) ?? [];

/** The instance type a class bound with `injectAs` must have: every port's, together. */
export type PortInstances<TPorts> = TPorts extends abstract new (
  ...args: never[]
) => infer TInstance
  ? TInstance
  : TPorts extends readonly [infer THead, ...infer TRest]
    ? PortInstances<THead> & PortInstances<TRest>
    : unknown;
