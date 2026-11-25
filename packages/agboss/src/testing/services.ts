import type { Class, ServiceEntry, Token } from "../components/injection.js";
import { injectAsOf } from "../components/injection.js";
import { channelTargetOf } from "../channels/pause-targets.js";

/**
 * What a test's `services` (#1324, #1328) bind in a container: the classes created instead of
 * others, and the values bound to tokens. A class takes the place of every token it is — its
 * `injectAs` ports, the pause target it serves as a `@Channel`, and each class it extends — so a
 * fake that `extends` the real service (or names its port with `injectAs`) needs nothing else.
 */
export interface ServiceBindings {
  /** Each token a service class is, to that class. */
  readonly replacements: ReadonlyMap<Class, Class>;
  /** The `provide(TOKEN, value)` entries. */
  readonly values: ReadonlyMap<Token, unknown>;
}

/** The classes a class extends, nearest first (the framework's `Function.prototype` ends the chain). */
function ancestorsOf(cls: Class): readonly Class[] {
  const found: Class[] = [];
  let next: unknown = Object.getPrototypeOf(cls);
  while (typeof next === "function" && next !== Function.prototype) {
    found.push(next as Class);
    next = Object.getPrototypeOf(next);
  }
  return found;
}

/** The tokens a service class stands for. */
function tokensOf(cls: Class): readonly Class[] {
  const target = channelTargetOf(cls);
  return [...injectAsOf(cls), ...(target === undefined ? [] : [target]), ...ancestorsOf(cls)];
}

/** The bindings of a test's `services`: a later class for the same token wins. */
export function bindingsOf(services: readonly ServiceEntry[] = []): ServiceBindings {
  const replacements = new Map<Class, Class>();
  const values = new Map<Token, unknown>();
  for (const service of services) {
    if (typeof service === "function") {
      for (const token of tokensOf(service)) replacements.set(token, service);
    } else {
      values.set(service.provide, service.useValue);
    }
  }
  return { replacements, values };
}
