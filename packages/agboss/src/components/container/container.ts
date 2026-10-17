import { InjectionToken, tokenName, type Class, type Token } from "../injection.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { ComponentError, componentOf } from "../metadata.js";
import { Registrations, type ProviderModule, type Registration } from "./registrations.js";

/**
 * The container of an application instance (#261): one for the whole instance, no scopes — every
 * class it creates is created once (`OrderBook` listed by two workflows is one instance), its
 * dependencies first. Components keep no state of an execution: they read it from the live
 * `ExecutionContext`.
 */

/** A component's constructor dependencies: every decorator kind that takes `deps` records them. */
export const depsOf = (cls: Class): readonly Token[] => {
  const meta = componentOf(cls)?.meta;
  if (meta !== undefined && "deps" in meta) return meta.deps;
  const options = declarationOf(cls)?.options;
  return options !== undefined && "deps" in options ? (options.deps ?? []) : [];
};

/** Whether a framework decorator (a component's or a flow node's) describes the class. */
export const isDecorated = (cls: Class): boolean =>
  componentOf(cls) !== undefined || declarationOf(cls) !== undefined;

/**
 * A core value the app does not have (e.g. no environment): registered so the graph checks pass,
 * failing with its message — naming the component that needs it — only when something injects it.
 */
export class UnavailableValue {
  constructor(readonly message: (dependant: string) => string) {}
}

/**
 * A core value made for each class that injects it (the live `ExecutionContext`, which names its
 * consumer when read outside an execution): never cached, one per dependant.
 */
export class DependantValue {
  constructor(readonly valueFor: (dependant: string) => unknown) {}
}

/** How one app's container differs: values that replace registrations (test mocks), a creation hook. */
export interface ContainerOptions {
  readonly overrides?: ReadonlyMap<Token, unknown>;
  /** Called with every instance the container creates (not with values or overrides). */
  readonly onCreate?: (instance: unknown) => void;
}

/** What the container is built from: the providers of every workflow, the core values, defaults. */
export interface ContainerSources {
  readonly modules: readonly ProviderModule[];
  readonly core: ReadonlyMap<Token, unknown>;
  /** The framework's default implementation of each contract: used when no class implements it. */
  readonly defaults?: ReadonlyMap<Class, Class>;
}

export interface Container {
  readonly get: (token: Token) => unknown;
  /** Class names in creation order (dependencies before dependants). */
  readonly created: readonly string[];
}

/** What a token is registered as; an unregistered class (a tool, an action) is its own registration. */
function registrationOf(
  registrations: Registrations,
  token: Token,
  dependant: string,
): Registration {
  const found = registrations.find(token, dependant);
  if (found?.kind === "value" && found.value instanceof UnavailableValue) {
    throw new ComponentError(found.value.message(dependant));
  }
  if (found === undefined && token instanceof InjectionToken) {
    throw new ComponentError(`"${tokenName(token)}" is not registered in @Workflow({ providers })`);
  }
  return found ?? { kind: "class", cls: token as Class };
}

type Resolve = (token: Token, dependant: string) => unknown;

/** A new instance of `cls`, its dependencies resolved first. */
function construct(cls: Class, resolve: Resolve): unknown {
  const args = depsOf(cls).map((dep) => resolve(dep, tokenName(cls)));
  if (args.length === 0 && cls.length > 0 && !isDecorated(cls)) {
    throw new ComponentError(
      `[di.undecorated-provider] ${tokenName(cls)} takes ${String(cls.length)} constructor argument(s) but has no @Injectable({ deps }) or similar decorator.`,
    );
  }
  return new (cls as unknown as new (...a: unknown[]) => unknown)(...args);
}

/**
 * Creates every class once, dependencies first; `created` records the order. A dependency on a
 * contract gets the one class that implements it (the same instance as asking for that class).
 */
export function createContainer(
  sources: ContainerSources,
  options: ContainerOptions = {},
): Container {
  const registrations = new Registrations(sources.modules, sources.core, sources.defaults);
  registrations.override(options.overrides ?? new Map());
  const instances = new Map<Token, unknown>();
  const created: string[] = [];
  const instanceOf = (cls: Class): unknown => {
    if (instances.has(cls)) return instances.get(cls);
    const instance = construct(cls, resolve);
    instances.set(cls, instance);
    created.push(tokenName(cls));
    options.onCreate?.(instance);
    return instance;
  };
  const resolve = (token: Token, dependant = "the app"): unknown => {
    const registration = registrationOf(registrations, token, dependant);
    if (registration.kind === "class") return instanceOf(registration.cls);
    const { value } = registration;
    return value instanceof DependantValue ? value.valueFor(dependant) : value;
  };
  return { get: (token: Token): unknown => resolve(token), created };
}
