import type { EnvContract } from "./env-ref.js";
import {
  isResolvedSecret,
  OptionalSecretReference,
  resolvedSecret,
  Secret,
  variableOfSecret,
} from "./secret.js";
import { VariablePresence, VariableReference } from "./variables.js";

/**
 * The `configureEnv` values of an instance (#1324b): they ride on its `processEnv`, keyed by the
 * reference they stand in for, so every reader of a reference — a `defineEnv`'s `deps: [appEnv]`, a
 * storage driver's, a model provider's, the mesh's, an A2A agent's, an MCP server's option — sees the
 * same value and never the variable's default behind the override's back.
 */

/** What an override can break, collected like `resolveEnv`'s own problems. */
export interface OverrideProblems {
  readonly missing: string[];
  readonly invalid: string[];
}

/** Values given in place of the process's, per key (a test's, a profile's). */
export interface EnvOverrides<TContract extends EnvContract> {
  readonly contract: TContract;
  readonly values: Readonly<Partial<Record<keyof TContract & string, unknown>>>;
}

const OVERRIDES = Symbol.for("agboss.environments.overrides");

/** The `configureEnv` values a process-variable map carries, by the reference they stand in for. */
export const overridesOf = (
  processEnv: NodeJS.ProcessEnv,
): ReadonlyMap<unknown, unknown> | undefined =>
  (processEnv as { readonly [OVERRIDES]?: ReadonlyMap<unknown, unknown> })[OVERRIDES];

/** A copy of `processEnv` that carries `overrides`; `processEnv` itself when they name nothing. */
export function processEnvWith(
  processEnv: NodeJS.ProcessEnv,
  overrides: readonly EnvOverrides<EnvContract>[],
): NodeJS.ProcessEnv {
  const byReference = new Map<unknown, unknown>();
  for (const { contract, values } of overrides)
    for (const [key, value] of Object.entries(values))
      if (Object.hasOwn(contract, key)) byReference.set(contract[key], value);
  if (byReference.size === 0) return processEnv;
  const carried: NodeJS.ProcessEnv = { ...processEnv };
  Object.defineProperty(carried, OVERRIDES, { value: byReference });
  return carried;
}

const variableOfAny = (ref: Secret | OptionalSecretReference): string =>
  ref instanceof OptionalSecretReference ? ref.variable : variableOfSecret(ref);

/** An override of a secret key: a non-empty text becomes a `Secret`; nothing is a missing variable. */
function secretOverride(
  ref: Secret | OptionalSecretReference,
  value: unknown,
  key: string,
  problems: OverrideProblems,
): unknown {
  if (typeof value === "string" && value !== "") return resolvedSecret("(override)", value);
  if (value instanceof Secret && isResolvedSecret(value)) return value;
  if (ref instanceof OptionalSecretReference && (value === undefined || value === ""))
    return undefined;
  problems.missing.push(`${variableOfAny(ref)} has no value (${key})`);
  return undefined;
}

/** An override of a value key: none for a required key is a missing variable; a text is parsed. */
function variableOverride(
  ref: VariableReference,
  value: unknown,
  key: string,
  problems: OverrideProblems,
): unknown {
  const required = ref.fallback === undefined && ref.presence === VariablePresence.Required;
  if (value === undefined && required)
    problems.missing.push(`${ref.variable} has no value (${key})`);
  if (typeof value !== "string" || ref.parser === undefined) return value;
  const parsed = ref.parser(value);
  if (parsed === undefined)
    problems.invalid.push(`${ref.variable} is not ${ref.expected ?? "valid"} (${key})`);
  return parsed;
}

/**
 * An override as the value of its key: never a quiet default (an empty secret, a missing value for a
 * required key is a missing variable), a text for a typed value is parsed.
 */
export function overriddenOf(
  ref: unknown,
  value: unknown,
  key: string,
  problems: OverrideProblems,
): unknown {
  if (ref instanceof Secret || ref instanceof OptionalSecretReference)
    return secretOverride(ref, value, key, problems);
  return ref instanceof VariableReference ? variableOverride(ref, value, key, problems) : value;
}
