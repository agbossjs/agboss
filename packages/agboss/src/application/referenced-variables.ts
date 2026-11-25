import { componentOf } from "../components/metadata.js";
import type { Class } from "../components/injection.js";
import { processVariableOf, type ProcessVariable } from "../environments/resolve.js";
import { OptionalSecretReference, Secret } from "../environments/secret.js";
import { VariableReference } from "../environments/variables.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * The process variables an application's components read through `defineEnv` references (#1324): an
 * `env(…)` or `secret(…)` in a component's options — a storage driver's file, its secrets, an A2A
 * agent's url, a budget's limit. Found by walking the decorator options of every component the
 * application assembles; each variable once, in the order found, never a value.
 */

type Reference = VariableReference | Secret | OptionalSecretReference;

const isReference = (value: unknown): value is Reference =>
  value instanceof VariableReference ||
  value instanceof Secret ||
  value instanceof OptionalSecretReference;

const isWalked = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  (Array.isArray(value) ||
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Every reference inside `value` (plain objects and lists, any depth), with its path. */
function referencesIn(
  value: unknown,
  path: string,
  seen: Set<object>,
): readonly (readonly [string, Reference])[] {
  if (isReference(value)) return [[path, value]];
  if (!isWalked(value) || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, inner]) =>
    referencesIn(inner, `${path}.${key}`, seen),
  );
}

/** The classes whose options can hold a reference: everything the application lists or reaches. */
function componentsOf(assembled: AssembledApplication): readonly Class[] {
  const listed = [
    ...assembled.modules.flatMap((module) => module.providers),
    ...assembled.budgets,
    ...assembled.endpoints,
    ...assembled.observers,
    ...assembled.healthChecks,
    ...assembled.workflows.flatMap((workflow) => [
      ...workflow.modelProviders,
      ...(workflow.mcpServerClasses?.keys() ?? []),
    ]),
  ];
  return [
    ...new Set(listed.filter((provider): provider is Class => typeof provider === "function")),
  ];
}

/** The variables the application's components name, once each, in the order found. */
export function referencedVariablesOf(assembled: AssembledApplication): readonly ProcessVariable[] {
  const seen = new Set<object>();
  const storage = [
    assembled.storage?.database,
    assembled.storage?.cluster,
    assembled.storage?.objects,
  ].flatMap((entry) => (entry === undefined ? [] : [[entry.cls.name, entry.meta] as const]));
  const components = componentsOf(assembled).flatMap((cls) => {
    const meta = componentOf(cls);
    return meta === undefined ? [] : [[cls.name, meta] as const];
  });
  const variables = new Map<string, ProcessVariable>();
  for (const [name, meta] of [...storage, ...components])
    for (const [path, reference] of referencesIn(meta, name, seen)) {
      const found = processVariableOf(path, reference);
      if (!variables.has(found.variable)) variables.set(found.variable, found);
    }
  return [...variables.values()];
}
