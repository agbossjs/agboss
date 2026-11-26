import { depsOf } from "../components/container/container.js";
import { isEnvContract } from "../environments/define-env.js";
import { usedComponentsOf } from "../testing/workflow-parts.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { componentOf } from "../components/metadata.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import type { Class } from "../components/injection.js";
import {
  processVariableOf,
  VariableUse,
  type ProcessVariable,
} from "../environments/process-variable.js";
import { OptionalSecretReference, Secret } from "../environments/secret.js";
import { VariableReference } from "../environments/variables.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * The process variables an application's components read through `defineEnv` references (#1324): an
 * `env(…)` or `secret(…)` in a component's options — a storage driver's file, its secrets, an A2A
 * agent's url, a budget's limit. Found by walking the decorator options of every component the
 * application assembles; each variable once, in the order found, never a value.
 */

export type Reference = VariableReference | Secret | OptionalSecretReference;

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

/**
 * The references of every `defineEnv` a component reads with `deps: [appEnv]` — a workflow's action,
 * tool, router, a service, an observer: every variable of that dictionary is the component's.
 */
function envDepsOf(assembled: AssembledApplication): readonly (readonly [string, Reference])[] {
  const classes = new Set([...componentsOf(assembled), ...usedComponentsOf(assembled)]);
  return [...classes].flatMap((cls) =>
    depsOf(cls)
      .filter(isEnvContract)
      .flatMap((contract) =>
        Object.entries(contract as Readonly<Record<string, unknown>>).flatMap(([key, reference]) =>
          isReference(reference) ? [[`${cls.name}.deps.${key}`, reference] as const] : [],
        ),
      ),
  );
}

/** One reference an application's options hold: whose it is, where, and the reference itself. */
export interface OwnedReference {
  readonly owner: string;
  readonly path: string;
  readonly reference: Reference;
}

/**
 * Every reference of the application's options, none left out for being a second use of a variable:
 * the storage components', the components' (providers, model providers, budgets, endpoints, …), the
 * mesh's and the PII policies' (the application's and its workflows'), and the `deps: [appEnv]` ones.
 */
export function referencesOf(assembled: AssembledApplication): readonly OwnedReference[] {
  const storages = [
    assembled.storage?.database,
    assembled.storage?.cluster,
    assembled.storage?.objects,
  ].flatMap((entry) => (entry === undefined ? [] : [[entry.cls.name, entry.meta] as const]));
  const policies = [
    ...assembled.piiPolicies,
    ...assembled.workflows.flatMap((one) => one.pii?.classes ?? []),
  ];
  const components = [...componentsOf(assembled), ...policies].flatMap((cls) => {
    const meta = isModelProviderClass(cls)
      ? modelProviderOf(cls)
      : (componentOf(cls) ?? piiPolicyMetaOf(cls));
    return meta === undefined ? [] : [[cls.name, meta] as const];
  });
  const mesh = assembled.mesh === undefined ? [] : [["@Mesh", assembled.mesh] as const];
  const own = [...storages, ...components, ...mesh].flatMap(([owner, meta]) =>
    referencesIn(meta, owner, new Set()).map(([path, reference]) => ({ owner, path, reference })),
  );
  const deps = envDepsOf(assembled).map(([path, reference]) => ({
    owner: path.split(".")[0] ?? path,
    path,
    reference,
  }));
  return [...own, ...deps];
}

/** Two reads of one variable as one: required anywhere = required, a secret anywhere = a secret. */
function mergedVariable(known: ProcessVariable, found: ProcessVariable): ProcessVariable {
  return {
    variable: known.variable,
    field: known.field,
    use:
      known.use === VariableUse.Secret || found.use === VariableUse.Secret
        ? VariableUse.Secret
        : VariableUse.Value,
    required: known.required || found.required,
    optional: known.optional && found.optional,
  };
}

/**
 * The variables the application's components name, once each, in the order found: every reference
 * of `referencesOf` (storages, components, the mesh, the PII policies, `deps: [appEnv]`). A variable
 * read in several places is one entry that is required when any read requires it.
 */
export function referencedVariablesOf(assembled: AssembledApplication): readonly ProcessVariable[] {
  const variables = new Map<string, ProcessVariable>();
  for (const { path, reference } of referencesOf(assembled)) {
    const found = processVariableOf(path, reference);
    const known = variables.get(found.variable);
    variables.set(found.variable, known === undefined ? found : mergedVariable(known, found));
  }
  return [...variables.values()];
}

/** The references a selected profile gives a value through `configureEnv` (a secret never: a profile cannot carry one). */
function providedReferencesOf(assembled: AssembledApplication): ReadonlySet<unknown> {
  const provided = new Set<unknown>();
  for (const { contract, values } of assembled.envOverrides)
    for (const key of Object.keys(values)) provided.add(Reflect.get(contract, key));
  return provided;
}

/**
 * The required variables nothing sets: a required read — a reference with no default, or a secret —
 * that neither the process's variables nor the selected profile's `configureEnv` (which gives a value
 * to the references of its own `defineEnv` only) satisfy. Each variable once, as `referencedVariablesOf`
 * lists it; a variable read in two places is unset when either place has nothing.
 */
export function unsetVariablesOf(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
): readonly ProcessVariable[] {
  const provided = providedReferencesOf(assembled);
  const names = new Set<string>();
  for (const { path, reference } of referencesOf(assembled)) {
    const found = processVariableOf(path, reference);
    if (found.required && !provided.has(reference) && (processEnv[found.variable] ?? "") === "")
      names.add(found.variable);
  }
  return referencedVariablesOf(assembled).filter((found) => names.has(found.variable));
}

/** A variable that is set but is not what its reference reads: named, never its value. */
export interface InvalidVariable {
  readonly variable: string;
  readonly field: string;
  readonly expected: string;
}

/**
 * Every referenced variable the process sets to something its reference cannot read (`PORT=abc` for
 * `env.integer`): what `agboss check --strict` reports as `[environment.invalid-value]`. A variable a
 * profile provides is read from the profile, not the process.
 */
export function invalidVariablesOf(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
): readonly InvalidVariable[] {
  const provided = providedReferencesOf(assembled);
  const seen = new Set<string>();
  const invalid: InvalidVariable[] = [];
  for (const { path, reference } of referencesOf(assembled)) {
    if (!(reference instanceof VariableReference) || provided.has(reference)) continue;
    const raw = processEnv[reference.variable] ?? "";
    if (raw === "" || seen.has(reference.variable)) continue;
    seen.add(reference.variable);
    if (reference.parser?.(raw) === undefined)
      invalid.push({
        variable: reference.variable,
        field: path,
        expected: reference.expected ?? "valid",
      });
  }
  return invalid;
}
