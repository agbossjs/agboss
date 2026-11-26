import { ConfigError } from "../core/error-families/config-errors.js";
import type { EnvContract, EnvSpec, InferEnv, ReservedEnvKey, SecretRef } from "./env-ref.js";
import { invalidValueError, missingVariableError } from "./environment-rules.js";
import {
  isResolvedSecret,
  OptionalSecretReference,
  resolvedSecret,
  Secret,
  variableOfSecret,
} from "./secret.js";
import { VariablePresence, VariableReference } from "./variables.js";
import { overriddenOf, overridesOf, type EnvOverrides } from "./overrides.js";

export { processEnvWith, type EnvOverrides } from "./overrides.js";

/**
 * `defineEnv` (#1324): the one place an application reads its process variables. It returns a dictionary of
 * the references it was given — `appEnv.apiKey` is the `SecretRef` a component option takes — that is also a
 * dependency token: `deps: [appEnv]` injects `InferEnv<typeof appEnv>`, the values resolved when the
 * application starts (a secret as a `Secret`, read with `.reveal()`).
 */

const CONTRACT = Symbol.for("agboss.environments.contract");
const RESERVED: ReadonlySet<string> = new Set(["then", "__proto__", "constructor", "prototype"]);

/** The reference a key holds, or why it holds none. */
const isReference = (
  value: unknown,
): value is VariableReference | Secret | OptionalSecretReference =>
  value instanceof VariableReference ||
  value instanceof Secret ||
  value instanceof OptionalSecretReference;

/** Whether `value` is a `defineEnv` value reference (`env.usd("VAR")`, `appEnv.limit`), not a secret. */
export const isVariableReference = (value: unknown): value is VariableReference =>
  value instanceof VariableReference;

/** Whether `value` is a `defineEnv` dictionary: a dependency token for its resolved values. */
export const isEnvContract = (value: unknown): value is EnvContract =>
  typeof value === "object" && value !== null && Reflect.has(value, CONTRACT);

/** Declares the variables an application reads; a reserved or foreign key fails here, not at start. */
export function defineEnv<const TSpec extends EnvSpec>(spec: {
  readonly [TKey in keyof TSpec]: TKey extends ReservedEnvKey ? never : TSpec[TKey];
}): EnvContract<TSpec> {
  const dictionary: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(spec)) {
    if (RESERVED.has(key) || !isReference(value)) {
      throw new ConfigError.Environment({
        message: RESERVED.has(key)
          ? `defineEnv: "${key}" is a reserved key — rename it`
          : `defineEnv: "${key}" is no env(…) or secret(…) reference`,
      });
    }
    dictionary[key] = value;
  }
  Object.defineProperty(dictionary, CONTRACT, { value: true });
  return Object.freeze(dictionary) as EnvContract<TSpec>;
}

/** `configureEnv(appEnv, { region: "eu" })`: overrides tied to one `defineEnv`, so two never collide on a key. */
export const configureEnv = <TContract extends EnvContract>(
  contract: TContract,
  values: Readonly<Partial<InferEnv<TContract>>>,
): EnvOverrides<TContract> => ({ contract, values });

/** A bearer token header from a secret (`Authorization: Bearer …`): `bearer(appEnv.apiKey)`. */
export interface HeaderSecretTemplate {
  readonly kind: "bearer";
  readonly secret: SecretRef;
}

export const bearer = (secret: SecretRef): HeaderSecretTemplate =>
  Object.freeze({ kind: "bearer", secret });

const present = (processEnv: NodeJS.ProcessEnv, variable: string): string | undefined => {
  const value = processEnv[variable];
  return value === undefined || value === "" ? undefined : value;
};

/** A secret key's value, or the missing variable; an optional secret may be absent. */
function secretValueOf(
  ref: Secret | OptionalSecretReference,
  processEnv: NodeJS.ProcessEnv,
  problems: Problems,
  key: string,
): unknown {
  const isOptional = ref instanceof OptionalSecretReference;
  const variable = isOptional ? ref.variable : variableOfSecret(ref);
  const raw = present(processEnv, variable);
  if (raw === undefined && !isOptional && problems.deferred) return ref;
  if (raw === undefined && !isOptional) problems.missing.push(`${variable} is not set (${key})`);
  return raw === undefined ? undefined : resolvedSecret(variable, raw);
}

/** A variable key's value: its default when unset, its parsed text when set; or the problem. */
function variableValueOf(
  ref: VariableReference,
  processEnv: NodeJS.ProcessEnv,
  problems: Problems,
  key: string,
): unknown {
  const raw = present(processEnv, ref.variable);
  if (raw === undefined) {
    if (ref.fallback === undefined && ref.presence === VariablePresence.Required)
      problems.missing.push(`${ref.variable} is not set (${key})`);
    return ref.fallback;
  }
  const parsed = ref.parser === undefined ? raw : ref.parser(raw);
  if (parsed === undefined)
    problems.invalid.push(`${ref.variable} is not ${ref.expected ?? "valid"} (${key})`);
  return parsed;
}

/** The variables of one key as its value, or the problem with it (named, never its value). */
function valueOf(
  key: string,
  ref: unknown,
  processEnv: NodeJS.ProcessEnv,
  problems: Problems,
): unknown {
  // a `configureEnv` value stands in for the process's, wherever the reference is read: in a
  // `defineEnv`, a storage's driver, a model provider's, a mesh's, an A2A agent's or an MCP server's options
  const given = overridesOf(processEnv);
  if (given?.has(ref)) return overriddenOf(ref, given.get(ref), key, problems);
  if (ref instanceof Secret || ref instanceof OptionalSecretReference)
    return secretValueOf(ref, processEnv, problems, key);
  return ref instanceof VariableReference
    ? variableValueOf(ref, processEnv, problems, key)
    : undefined;
}

/** What went wrong with the variables of one contract, over every key. */
class Problems {
  readonly missing: string[] = [];
  readonly invalid: string[] = [];

  /** `deferred`: a secret whose variable is unset stays an unresolved `Secret` (types and assembly need no key, #266). */
  constructor(readonly deferred = false) {}

  throwIfAny(): void {
    if (this.missing.length > 0)
      throw missingVariableError(this.missing.join("; [environment.missing-variable] "));
    if (this.invalid.length > 0)
      throw invalidValueError(this.invalid.join("; [environment.invalid-value] "));
  }
}

/** How `resolveEnv` treats what it cannot resolve. */
export interface ResolveEnvOptions {
  /** `deferred`: a secret whose variable is unset stays an unresolved `Secret`, no problem (types and describe need no key). */
  readonly secrets?: "required" | "deferred";
}

/**
 * The values of `contract` with this process environment (every problem at once, naming variables and
 * never values), `overrides` taking the place of the process's for their keys.
 */
export function resolveEnv<TContract extends EnvContract>(
  contract: TContract,
  processEnv: NodeJS.ProcessEnv,
  overrides?: EnvOverrides<TContract>,
  options: ResolveEnvOptions = {},
): InferEnv<TContract> {
  const problems = new Problems(options.secrets === "deferred");
  const given: Readonly<Record<string, unknown>> = overrides?.values ?? {};
  const values = Object.fromEntries(
    Object.entries(contract).map(([key, ref]) => [
      key,
      Object.hasOwn(given, key)
        ? overriddenOf(ref, given[key], key, problems)
        : valueOf(key, ref, processEnv, problems),
    ]),
  );
  problems.throwIfAny();
  return Object.freeze(values) as InferEnv<TContract>;
}

/** Whether `value` is an object literal (or one without a prototype): what a settings object is. */
const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** One reference of a settings object as its value; any other value as it is. */
function resolvedReferenceOf(
  path: string,
  value: unknown,
  processEnv: NodeJS.ProcessEnv,
  problems: Problems,
): unknown {
  if (value instanceof Secret && isResolvedSecret(value)) return value;
  if (isReference(value)) return valueOf(path, value, processEnv, problems);
  if (Array.isArray(value))
    return value.map((item, index) =>
      resolvedReferenceOf(`${path}[${String(index)}]`, item, processEnv, problems),
    );
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      resolvedReferenceOf(`${path}.${key}`, inner, processEnv, problems),
    ]),
  );
}

/**
 * The settings of a storage driver (#1321) with every `env(…)` / `secret(…)` reference in them (at any
 * depth of its plain objects and lists) replaced by its value, read from `processEnv` once, when the
 * application starts: every problem at once, naming variables and never values.
 */
export function resolveReferences(
  settings: Readonly<Record<string, unknown>>,
  processEnv: NodeJS.ProcessEnv,
  what: string,
): Readonly<Record<string, unknown>> {
  const problems = new Problems();
  const resolved = resolvedReferenceOf(what, settings, processEnv, problems);
  problems.throwIfAny();
  return Object.freeze(resolved);
}

/** A container's `envOf` for a process's variables (default: the real one): what `deps: [appEnv]` reads. */
export const envOfProcess =
  (processEnv: NodeJS.ProcessEnv = process.env) =>
  (contract: EnvContract): unknown =>
    resolveEnv(contract, processEnv);

/** A container's `envOf` with secrets left unresolved: `agboss check` and `describe` need no key (#266). */
export const deferredEnvOf = (contract: EnvContract): unknown =>
  resolveEnv(contract, process.env, undefined, { secrets: "deferred" });
