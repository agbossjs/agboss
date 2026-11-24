import { isEnvContract } from "../environments/define-env.js";
import { isModelProviderClass } from "../models/model-provider.decorator.js";
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

/** The keys of one workflow's overlay only TypeScript holds. */
export const TYPESCRIPT_ONLY_WORKFLOW_KEYS = ["modelProvider"] as const;

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const without = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** The constant part of a spec: what the zod schema validates. */
function constantsOf(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest = without(spec, TYPESCRIPT_ONLY_KEYS);
  const { workflows } = rest;
  if (!isPlain(workflows)) return rest;
  return {
    ...rest,
    workflows: Object.fromEntries(
      Object.entries(workflows).map(([name, workflow]) => [
        name,
        isPlain(workflow) ? without(workflow, TYPESCRIPT_ONLY_WORKFLOW_KEYS) : workflow,
      ]),
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
