import type { Class } from "../components/injection.js";
import type { ProviderModule } from "../components/container/registrations.js";

/** Whether a class is listed in the application's or one of its workflows' `providers`. */
export type ListedProviderCheck = (cls: Class) => boolean;

const checks = new WeakMap<object, ListedProviderCheck>();

/** Remembers, for an application instance, which classes it lists (#387: the A2A caller resolver). */
export function rememberListedProviders(app: object, isListed: ListedProviderCheck): void {
  checks.set(app, isListed);
}

/** The check of an instance's modules: a class any of them lists (values bound by `provide` are not). */
export const listedProviderCheckOf =
  (modules: readonly ProviderModule[]): ListedProviderCheck =>
  (cls) =>
    modules.some((module) => module.providers.includes(cls));

/**
 * Whether the instance lists the class: `undefined` for an object no application instance made
 * (a host's own `A2AApp`), which is then not checked.
 */
export const isListedProvider = (app: object, cls: Class): boolean | undefined =>
  checks.get(app)?.(cls);
