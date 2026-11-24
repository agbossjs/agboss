import { InjectionToken, tokenName, type Class, type Token } from "../injection.js";
import { isEnvContract, resolveEnv } from "../../environments/define-env.js";
import type { EnvContract } from "../../environments/env-ref.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { arbiterOf } from "../../flow/decorators/arbiter.js";
import { replyInterpreterOf } from "../../channels/channel-role.decorator.js";
import { ComponentError, componentOf } from "../metadata.js";
import {
  isModelProviderClass,
  modelProviderDepsOf,
} from "../../models/model-provider.decorator.js";
import type { StoreBounds } from "../../app/store-bounds.js";
import { Registrations, type ProviderModule, type Registration } from "./registrations.js";

/**
 * The container of an application instance (#261): one for the whole instance, no scopes — every
 * class it creates is created once (`OrderBook` listed by two workflows is one instance), its
 * dependencies first. Components keep no state of an execution: they read it from the live
 * `ExecutionContext`.
 */

/** The options a flow node's, an arbiter's or a reply interpreter's decorator recorded. */
const declaredOptionsOf = (cls: Class) =>
  declarationOf(cls)?.options ?? arbiterOf(cls)?.options ?? replyInterpreterOf(cls)?.options;

/** A component's constructor dependencies: every decorator kind that takes `deps` records them. */
export const depsOf = (cls: Class): readonly Token[] => {
  const meta = componentOf(cls)?.meta;
  if (meta !== undefined && "deps" in meta) return meta.deps;
  const options = declaredOptionsOf(cls);
  if (options !== undefined && "deps" in options) return options.deps ?? [];
  // a transport @ModelProvider (#385): created by the application's container on its first call
  return modelProviderDepsOf(cls);
};

/** Whether a framework decorator (a component's or a flow node's) describes the class. */
export const isDecorated = (cls: Class): boolean =>
  componentOf(cls) !== undefined ||
  declarationOf(cls) !== undefined ||
  arbiterOf(cls) !== undefined ||
  replyInterpreterOf(cls) !== undefined ||
  isModelProviderClass(cls);

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

/**
 * What every container of one application instance shares (#261): the providers of the application
 * and of all its workflows, the infrastructure defaults and core values, and the instances — so a
 * class is created once for the whole application, whichever workflow asks for it first.
 */
export interface ApplicationContainer {
  readonly modules: readonly ProviderModule[];
  readonly core: ReadonlyMap<Token, unknown>;
  readonly defaults: ReadonlyMap<Class, Class>;
  readonly instances: Map<Token, unknown>;
  /** The bounds of the instance's store calls (#928), when it has them. */
  readonly bounds?: StoreBounds | undefined;
}

/** How one app's container differs: values that replace registrations (test mocks), a creation hook. */
export interface ContainerOptions {
  readonly overrides?: ReadonlyMap<Token, unknown>;
  /**
   * Classes created instead of others (a test's `override(Class, Replacement)`, #262): wherever a
   * token is asked for, the container gives its instance of the replacement — over any listed class.
   */
  readonly replacements?: ReadonlyMap<Class, Class>;
  /** Called with every instance the container creates (not with values or overrides). */
  readonly onCreate?: (instance: unknown) => void;
  /**
   * What the container stores and hands out for a new instance of `cls` (#928: a store bounded by a
   * proxy). `onCreate` and the lifecycle hooks get the instance itself.
   */
  readonly decorate?: (cls: Class, instance: unknown) => unknown;
  /** The application this container belongs to: its providers, defaults and instances, shared. */
  readonly application?: ApplicationContainer;
  /** The values of a `defineEnv` dictionary a class asks for (#1324); default: this process's variables. */
  readonly envOf?: (contract: EnvContract) => unknown;
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

const unregistered = (token: Token, dependant: string): ComponentError =>
  new ComponentError({
    message: `[di.unregistered-token] ${dependant}: "${tokenName(token)}" is not registered in @Workflow({ providers })`,
  });

/**
 * Whether nothing may be created for an unregistered `token`: a named value is never its own
 * registration; a decorated class is (found through `deps`, #1324); in an application an undecorated
 * one — a port nothing is `injectAs` for — is never `new`-ed (a workflow on its own, `agboss check`,
 * still does).
 */
const isRefused = (token: Token, isStrict: boolean): boolean =>
  token instanceof InjectionToken ||
  (isStrict && typeof token === "function" && !isDecorated(token));

/** What a token is registered as; an unregistered class (a tool, an action) is its own registration. */
function registrationOf(
  registrations: Registrations,
  token: Token,
  dependant: string,
  isStrict: boolean,
): Registration {
  const found = registrations.find(token, dependant);
  if (found?.kind === "value" && found.value instanceof UnavailableValue) {
    throw new ComponentError({ message: found.value.message(dependant) });
  }
  if (found === undefined && isRefused(token, isStrict)) throw unregistered(token, dependant);
  return found ?? { kind: "class", cls: token as Class };
}

type Resolve = (token: Token, dependant: string) => unknown;

/** A new instance of `cls`, its dependencies resolved first. */
function construct(cls: Class, resolve: Resolve): unknown {
  const args = depsOf(cls).map((dep) => resolve(dep, tokenName(cls)));
  if (args.length === 0 && cls.length > 0 && !isDecorated(cls)) {
    throw new ComponentError({
      message: `[di.undecorated-provider] ${tokenName(cls)} takes ${String(cls.length)} constructor argument(s) but has no @Injectable({ deps }) or similar decorator.`,
    });
  }
  return new (cls as unknown as new (...a: unknown[]) => unknown)(...args);
}

/** The container's own sources and its application's, one registration per token. */
const registrationsOf = (
  sources: ContainerSources,
  shared: ApplicationContainer | undefined,
): Registrations =>
  new Registrations(
    [...sources.modules, ...(shared?.modules ?? [])],
    new Map([...(shared?.core ?? []), ...sources.core]),
    sources.defaults ?? shared?.defaults,
  );

/**
 * Whether a class is created for this container's workflow alone (#1324): it is listed in the
 * workflow's `services`, or something it depends on is — a class the application shares reaching a
 * port the workflow binds itself would otherwise give every workflow the first one's instance.
 */
function scopeChecker(registrations: Registrations): (cls: Class) => boolean {
  if (!registrations.hasScope) return () => false;
  const known = new Map<Token, boolean>();
  const visit = (token: Token, dependant: string): boolean => {
    const memo = known.get(token);
    if (memo !== undefined) return memo;
    // a cycle is no reason to be scoped: the cycle's other members decide
    known.set(token, false);
    const answer = (): boolean => {
      if (registrations.isScoped(token)) return true;
      const found = registrations.find(token, dependant);
      if (found?.kind === "value") return false;
      // an unlisted class is its own registration (found through `deps`)
      const cls = found?.cls ?? (typeof token === "function" ? token : undefined);
      if (cls === undefined) return false;
      if (registrations.isScoped(cls)) return true;
      return depsOf(cls).some((dep) => visit(dep, tokenName(cls)));
    };
    const result = answer();
    known.set(token, result);
    return result;
  };
  return (cls) => visit(cls, tokenName(cls));
}

/**
 * Creates every class once, dependencies first; `created` records the order. A dependency on a
 * contract gets the one class that implements it (the same instance as asking for that class).
 */
export function createContainer(
  sources: ContainerSources,
  options: ContainerOptions = {},
): Container {
  const registrations = registrationsOf(sources, options.application);
  registrations.override(options.overrides ?? new Map());
  registrations.replace(options.replacements ?? new Map());
  const shared = options.application?.instances ?? new Map<Token, unknown>();
  // a workflow's `services` (#1324): what depends on them is created for this workflow alone
  const scoped = new Map<Token, unknown>();
  const scopeOf = scopeChecker(registrations);
  const isInApplication = options.application !== undefined;
  const created: string[] = [];
  const instanceOf = (cls: Class): unknown => {
    const instances = scopeOf(cls) ? scoped : shared;
    if (instances.has(cls)) return instances.get(cls);
    const instance = construct(cls, resolve);
    const decorated = options.decorate?.(cls, instance) ?? instance;
    instances.set(cls, decorated);
    created.push(tokenName(cls));
    options.onCreate?.(instance);
    return decorated;
  };
  const envValues = new Map<EnvContract, unknown>();
  const resolve = (token: Token, dependant = "the app"): unknown => {
    if (isEnvContract(token)) {
      if (!envValues.has(token))
        envValues.set(token, options.envOf?.(token) ?? resolveEnv(token, process.env));
      return envValues.get(token);
    }
    const registration = registrationOf(registrations, token, dependant, isInApplication);
    if (registration.kind === "class") return instanceOf(registration.cls);
    const { value } = registration;
    return value instanceof DependantValue ? value.valueFor(dependant) : value;
  };
  return { get: (token: Token): unknown => resolve(token), created };
}
