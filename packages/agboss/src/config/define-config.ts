import { isEnvContract } from "../environments/define-env.js";
import { isModelProviderClass } from "../models/model-provider.decorator.js";
import { budgetOf } from "../budgets/budget.js";
import { memoryMetaOf } from "../memory/memory.decorator.js";
import { filePolicyMetaOf } from "../files/file-policy.js";
import { ProfileError, ProfileErrorReason } from "./profile-error.js";
import { ScalarOverlaySchema } from "./overlay-schema.js";
import type { ConfigSpec } from "./overlay-types.js";

const OVERLAY: unique symbol = Symbol.for("agboss.config.overlay");

/** One profile as `defineConfig` returns it: frozen, and the only thing a `.config.ts` may export. */
export type ConfigOverlay = Readonly<ConfigSpec> & { readonly [OVERLAY]: true };

/** The keys only TypeScript holds: classes and `configureEnv` values — never in a `.config.yaml`. */
export const TYPESCRIPT_ONLY_KEYS = [
  "env",
  "storage",
  "modelProvider",
  "channels",
  "healthChecks",
] as const;

/** The shelves whose entries may name a `@ModelProvider` by its class (`modelProvider`), which only TypeScript holds. */
export const COMPONENT_MODEL_SHELVES = [
  "judges",
  "arbiters",
  "guardrails",
  "piiPolicies",
  "channelInterpreters",
] as const;

/** The keys of one workflow's overlay only TypeScript holds. */
export const TYPESCRIPT_ONLY_WORKFLOW_KEYS = [
  "modelProvider",
  "budget",
  "memory",
  "filePolicy",
] as const;

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const without = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** A shelf of components without the provider classes of its entries: their names stay for the schema. */
const withoutProviderClasses = (shelf: unknown): unknown =>
  !isPlain(shelf)
    ? shelf
    : Object.fromEntries(
        Object.entries(shelf).map(([name, entry]) => [
          name,
          isPlain(entry) && typeof entry.modelProvider === "function"
            ? without(entry, ["modelProvider"])
            : entry,
        ]),
      );

/** One workflow's overlay without what only TypeScript holds: its provider class and its routers' provider classes. */
const workflowConstantsOf = (workflow: unknown): unknown =>
  !isPlain(workflow)
    ? workflow
    : {
        ...without(workflow, TYPESCRIPT_ONLY_WORKFLOW_KEYS),
        ...(workflow.routers === undefined
          ? {}
          : { routers: withoutProviderClasses(workflow.routers) }),
      };

/** The constant part of a spec: what the zod schema validates. */
function constantsOf(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest = {
    ...without(spec, TYPESCRIPT_ONLY_KEYS),
    ...Object.fromEntries(
      COMPONENT_MODEL_SHELVES.filter((key) => spec[key] !== undefined).map((key) => [
        key,
        withoutProviderClasses(spec[key]),
      ]),
    ),
  };
  const { workflows } = rest;
  if (!isPlain(workflows)) return rest;
  return {
    ...rest,
    workflows: Object.fromEntries(
      Object.entries(workflows).map(([name, workflow]) => [name, workflowConstantsOf(workflow)]),
    ),
  };
}

const invalid = (message: string): ProfileError =>
  new ProfileError({ reason: ProfileErrorReason.Invalid, message });

const isClassList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "function");

/** `env` holds `configureEnv(appEnv, { … })` values, one or a list. */
function checkEnv(env: unknown): void {
  const overrides = env === undefined ? [] : ([] as unknown[]).concat(env);
  for (const override of overrides) {
    if (!isPlain(override) || !isEnvContract(override.contract) || !isPlain(override.values))
      throw invalid("defineConfig: env takes configureEnv(appEnv, { … }), one per defineEnv");
  }
}

/** The `@ModelProvider` classes: the application's, and each workflow's. */
function checkProviders(spec: Readonly<Record<string, unknown>>): void {
  const { modelProvider, workflows } = spec;
  if (modelProvider !== undefined && !isModelProviderClass(modelProvider))
    throw invalid("defineConfig: modelProvider is no @ModelProvider class");
  for (const [name, workflow] of Object.entries(isPlain(workflows) ? workflows : {})) {
    const provider = isPlain(workflow) ? workflow.modelProvider : undefined;
    if (provider !== undefined && !isModelProviderClass(provider))
      throw invalid(`defineConfig: workflows.${name}.modelProvider is no @ModelProvider class`);
  }
}

/** What each class slot of a workflow takes: its key, its decorator and the check that the class has it. */
const CLASS_SLOTS: readonly (readonly [string, string, (cls: never) => unknown])[] = [
  ["budget", "@Budget", budgetOf],
  ["memory", "@Memory", memoryMetaOf],
  ["filePolicy", "@FilePolicy", filePolicyMetaOf],
];

/** The classes a workflow's overlay stands in for its own `budget` and `memory`. */
function checkClassSlots(spec: Readonly<Record<string, unknown>>): void {
  for (const [name, workflow] of Object.entries(isPlain(spec.workflows) ? spec.workflows : {})) {
    if (!isPlain(workflow)) continue;
    for (const [key, decorator, has] of CLASS_SLOTS) {
      const given = workflow[key];
      if (given === undefined) continue;
      if (typeof given !== "function" || has(given as never) === undefined)
        throw invalid(`defineConfig: workflows.${name}.${key} is no ${decorator} class`);
    }
  }
}

/** A component's `modelProvider` is a `@ModelProvider` class or its name. */
function checkComponentProviders(spec: Readonly<Record<string, unknown>>): void {
  const shelves: [string, unknown][] = COMPONENT_MODEL_SHELVES.map((key) => [key, spec[key]]);
  for (const [name, workflow] of Object.entries(isPlain(spec.workflows) ? spec.workflows : {}))
    shelves.push([`workflows.${name}.routers`, isPlain(workflow) ? workflow.routers : undefined]);
  for (const [where, shelf] of shelves) {
    for (const [name, entry] of Object.entries(isPlain(shelf) ? shelf : {})) {
      const provider = isPlain(entry) ? entry.modelProvider : undefined;
      if (typeof provider === "function" && !isModelProviderClass(provider))
        throw invalid(`defineConfig: ${where}.${name}.modelProvider is no @ModelProvider class`);
    }
  }
}

/** The lists of classes that stand in for the application's own. */
function checkClassLists(spec: Readonly<Record<string, unknown>>): void {
  for (const key of ["channels", "healthChecks"]) {
    if (spec[key] !== undefined && !isClassList(spec[key]))
      throw invalid(`defineConfig: ${key} takes a list of classes`);
  }
}

/** Checks the classes and `configureEnv` values of a spec: what the zod schema cannot see. */
function checkTypeScriptParts(spec: Readonly<Record<string, unknown>>): void {
  checkEnv(spec.env);
  checkProviders(spec);
  checkComponentProviders(spec);
  checkClassSlots(spec);
  checkClassLists(spec);
}

/** Why the constants of a spec are not valid: the first issue's path and rule, never the value. */
function checkConstants(spec: Readonly<Record<string, unknown>>): void {
  const parsed = ScalarOverlaySchema.safeParse(constantsOf(spec));
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") ?? "";
  throw invalid(`defineConfig: ${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid"}`);
}

/**
 * One profile of an application — `src/config/prod.config.ts`: `export default defineConfig({ … })` —
 * its model providers' and workflows' settings, and the `defineEnv` values and infrastructure classes
 * that stand in for the application's own. Checked here, when the module loads: a typo in a key, a wrong
 * value or a class that is none fails with its path, never a value.
 */
export function defineConfig(spec: ConfigSpec): ConfigOverlay {
  if (!isPlain(spec)) throw invalid("defineConfig takes an object of settings");
  checkTypeScriptParts(spec);
  checkConstants(spec);
  return Object.freeze({ ...spec, [OVERLAY]: true as const });
}

/** Whether a module's default export is what `defineConfig` returned. */
export const isConfigOverlay = (value: unknown): value is ConfigOverlay =>
  isPlain(value) && Reflect.get(value, OVERLAY) === true;
