import type { Class } from "../components/injection.js";
import {
  fallbackOf,
  isDriverOptions,
  isModelProviderClass,
  modelProviderOf,
  type KeptModelProviderOptions,
} from "./model-provider.decorator.js";

/**
 * The fallback chain of a provider (#1313): `A → B → C`, each provider naming its own `fallback`.
 * One place reads it, so the runner, the startup check and the rules agree on the hops and on the
 * model each hop is asked for.
 */

/** One hop of a chain: the provider, its options and the model it is asked for. */
export interface FallbackHop {
  readonly cls: Class;
  readonly options: KeptModelProviderOptions;
  /** The vendor's model name this hop is called with. */
  readonly model: string;
}

/** The roles of `options` that name `model` (`default` first when it is the provider's `model`). */
function rolesOf(options: KeptModelProviderOptions, model: string): readonly string[] {
  if (!isDriverOptions(options)) return [];
  const named = Object.entries(options.models ?? {})
    .filter(([, vendor]) => vendor === model)
    .map(([role]) => role);
  return options.model === model ? ["default", ...named] : named;
}

/** What a driver provider calls a role: its `models` entry, its `model` for `default`. */
function modelOfRole(options: KeptModelProviderOptions, role: string): string | undefined {
  if (!isDriverOptions(options)) return undefined;
  return options.models?.[role] ?? (role === "default" ? options.model : undefined);
}

/**
 * The model a fallback hop is called with: the hop's `models` entry for the previous hop's model (or
 * the first provider's), else the fallback's own name for a role the first provider's model has (so
 * `default` and `fast` follow the role, whatever the vendors call them), else the same name.
 */
function hopModelOf(
  mapped: Readonly<Record<string, string>>,
  hop: KeptModelProviderOptions,
  previous: string,
  first: { readonly model: string; readonly roles: readonly string[] },
): string {
  const explicit = mapped[previous] ?? mapped[first.model];
  if (explicit !== undefined) return explicit;
  for (const role of first.roles) {
    const named = modelOfRole(hop, role);
    if (named !== undefined) return named;
  }
  return first.model;
}

/**
 * The hops after `primary` for a call of `model`, in order. A provider met twice ends the chain
 * (the rule `[model-provider.fallback-cycle]` names it at assembly).
 */
export function fallbackHopsOf(primary: Class, model: string): readonly FallbackHop[] {
  const first = { model, roles: rolesOf(modelProviderOf(primary), model) };
  const seen = new Set<Class>([primary]);
  const hops: FallbackHop[] = [];
  let current: Class = primary;
  let previous = model;
  for (;;) {
    const next = fallbackOf(modelProviderOf(current));
    if (next === undefined || !isModelProviderClass(next.provider) || seen.has(next.provider))
      return hops;
    seen.add(next.provider);
    const options = modelProviderOf(next.provider);
    previous = hopModelOf(next.models, options, previous, first);
    hops.push({ cls: next.provider, options, model: previous });
    current = next.provider;
  }
}

/** Every fallback provider reachable from `classes` (the chains), not including the classes. */
export function fallbackClassesOf(classes: readonly Class[]): readonly Class[] {
  const found = new Set<Class>();
  const visit = (cls: Class): void => {
    const next = fallbackOf(modelProviderOf(cls))?.provider;
    if (next === undefined || !isModelProviderClass(next) || found.has(next)) return;
    found.add(next);
    visit(next);
  };
  classes.filter(isModelProviderClass).forEach(visit);
  return [...found];
}

/** The classes of a cycle `A → B → A` that `cls` starts, `undefined` when its chain has none. */
export function fallbackCycleOf(cls: Class): readonly Class[] | undefined {
  const path: Class[] = [];
  let current: Class | undefined = cls;
  while (current !== undefined && isModelProviderClass(current)) {
    const at = path.indexOf(current);
    if (at >= 0) return path.slice(at);
    path.push(current);
    current = fallbackOf(modelProviderOf(current))?.provider;
  }
  return undefined;
}
