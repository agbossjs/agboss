import { OBSERVER_HOOKS, type ObserverHook } from "../core/observer-hooks.js";
import { tokenName, type Class } from "./injection.js";
import { ComponentError } from "./metadata.js";

/** Component lifecycle hooks (`OnStart`, …): an observer may have them, they are not observer hooks. */
const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set(["onInit", "onStart", "onStop", "onDestroy"]);
const HOOKS: ReadonlySet<string> = new Set(OBSERVER_HOOKS);
const HOOK_LIKE = /^on[A-Z]/;

/** The method names of a class, its base classes included. */
function methodNamesOf(cls: Class): string[] {
  const names = new Set<string>();
  const prototype: unknown = Reflect.get(cls, "prototype");
  let proto = prototype;
  while (typeof proto === "object" && proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
      if (name !== "constructor" && typeof descriptor?.value === "function") names.add(name);
    }
    proto = Reflect.getPrototypeOf(proto);
  }
  return [...names];
}

/** Edit distance (insertions, deletions, substitutions) between two names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** The hook a misspelled name most likely meant. */
export function closestHook(name: string): ObserverHook {
  const lower = name.toLowerCase();
  const ranked = [...OBSERVER_HOOKS].sort(
    (a, b) => distance(lower, a.toLowerCase()) - distance(lower, b.toLowerCase()),
  );
  return ranked[0] ?? "onExecutionStart";
}

/** What is wrong with one observer class: hook-like methods that are no hook, or no hook at all. */
function observerViolations(cls: Class): string[] {
  const methods = methodNamesOf(cls);
  const unknown = methods.filter(
    (name) => HOOK_LIKE.test(name) && !HOOKS.has(name) && !LIFECYCLE_HOOKS.has(name),
  );
  const violations = unknown.map(
    (name) =>
      `[observer.unknown-hook] ${tokenName(cls)}.${name} is not an observer hook — did you mean ${closestHook(name)}?`,
  );
  if (unknown.length === 0 && !methods.some((name) => HOOKS.has(name))) {
    violations.push(
      `[observer.no-hooks] ${tokenName(cls)} is listed in @Application observers but implements no hook (declare hooks as methods: ${OBSERVER_HOOKS.slice(0, 4).join(", ")}, …)`,
    );
  }
  return violations;
}

/** Every `@Application({ observers })` class implements at least one hook, and no misspelled one. */
export function checkObservers(observers: readonly Class[]): void {
  const violations = observers.flatMap(observerViolations);
  if (violations.length > 0) throw new ComponentError(violations.join("\n"));
}
