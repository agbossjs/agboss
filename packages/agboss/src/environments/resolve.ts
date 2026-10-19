import type { Environment } from "../flow/generated-types.js";
import { EnvironmentError, EnvironmentErrorCode } from "./errors.js";
import { resolvedSecret, SECRET_MASK, Secret, variableOfSecret } from "./secret.js";
import { VariableKind, VariablePresence, VariableReference } from "./variables.js";
import { isProcessValue, leavesOf, mapLeaves, type ProcessValue } from "./walk.js";

/**
 * An environment file resolved against the process (#261): every `env(…)` and `secret(…)` replaced
 * by its variable's value. A missing variable fails the start naming it, the field and the
 * environment — never a value: `DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`.
 */

/** An environment file as loaded: its name, the contract's name and the exported object. */
export interface LoadedEnvironment {
  /** `prod` for `environments/prod.environment.ts`. */
  readonly name: string;
  /** The contract class's name (`AppEnvironment`), for messages. */
  readonly contract: string;
  /** `export const environment: AppEnvironment = { … }`. */
  readonly values: unknown;
}

/**
 * Whether resolving needs the secrets' values: `Required` at an app's start and under
 * `agboss check --models`; `Deferred` for `agboss check` on its own — types and assembly read the
 * contract's shape, so a secret whose variable is unset stays a `Secret` without a value.
 */
export enum SecretResolution {
  Required = "required",
  Deferred = "deferred",
}

/** One process variable an environment reads, and how it is printed. */
export enum VariableUse {
  Value = "value",
  Secret = "secret",
}

/** A process variable an environment reads: for `agboss check --env <name>`. */
export interface ProcessVariable {
  readonly variable: string;
  readonly field: string;
  readonly use: VariableUse;
  /** Whether it is required (no default, not optional); a secret always is. */
  readonly required: boolean;
  /** Whether unset is no value (`env.optional("X")`): neither required nor defaulted (#266 S90). */
  readonly optional: boolean;
}

/** Whether a reference is `env.optional(…)`: unset is `undefined`, not a missing variable. */
const isOptional = (value: ProcessValue): boolean =>
  value instanceof VariableReference && value.presence === VariablePresence.Optional;

const variableOf = (value: ProcessValue): string =>
  value instanceof Secret ? variableOfSecret(value) : value.variable;

/** The variable's value: unset or empty is no value. */
const processValueOf = (processEnv: NodeJS.ProcessEnv, variable: string): string | undefined => {
  const value = processEnv[variable];
  return value === undefined || value === "" ? undefined : value;
};

const FLAGS: Readonly<Record<string, boolean>> = {
  true: true,
  "1": true,
  false: false,
  "0": false,
};

/** A set variable as its kind's value; undefined when it does not parse. */
function parsed(reference: VariableReference, raw: string): string | number | boolean | undefined {
  if (reference.kind === VariableKind.Text) return raw;
  if (reference.kind === VariableKind.Flag) return FLAGS[raw.toLowerCase()];
  return /^-?\d+$/.test(raw) ? Number(raw) : undefined;
}

/** What went wrong with the variables of one environment, collected over every field. */
class Problems {
  readonly missing: string[] = [];
  readonly invalid: string[] = [];

  constructor(
    private readonly loaded: LoadedEnvironment,
    readonly secrets: SecretResolution = SecretResolution.Required,
  ) {}

  where(path: string): string {
    return `${this.loaded.contract}.${path}, ${this.loaded.name}`;
  }

  throwIfAny(): void {
    if (this.missing.length > 0)
      throw new EnvironmentError(EnvironmentErrorCode.MissingVariables, this.missing.join("; "));
    if (this.invalid.length > 0)
      throw new EnvironmentError(EnvironmentErrorCode.InvalidValue, this.invalid.join("; "));
  }
}

function resolvedValue(
  value: ProcessValue,
  path: string,
  env: NodeJS.ProcessEnv,
  problems: Problems,
): unknown {
  const variable = variableOf(value);
  const raw = processValueOf(env, variable);
  if (value instanceof Secret) {
    if (raw !== undefined) return resolvedSecret(variable, raw);
    if (problems.secrets === SecretResolution.Deferred) return value;
    problems.missing.push(`${variable} is not set (${problems.where(path)})`);
    return undefined;
  }
  if (raw === undefined) {
    if (value.fallback === undefined && value.presence === VariablePresence.Required)
      problems.missing.push(`${variable} is not set (${problems.where(path)})`);
    return value.fallback;
  }
  const result = parsed(value, raw);
  if (result === undefined)
    problems.invalid.push(
      `${variable} is not ${value.kind === VariableKind.Integer ? "an integer" : "a flag (true, false, 1, 0)"} (${problems.where(path)})`,
    );
  return result;
}

/** The values an environment file gives with this process environment; every problem at once. */
export function resolveEnvironment(
  loaded: LoadedEnvironment,
  processEnv: NodeJS.ProcessEnv,
  secrets: SecretResolution = SecretResolution.Required,
): Environment {
  const problems = new Problems(loaded, secrets);
  const values = mapLeaves(loaded.values, (value, path) =>
    isProcessValue(value) ? resolvedValue(value, path, processEnv, problems) : value,
  );
  problems.throwIfAny();
  return environmentOf(values);
}

/** The values of an environment file: tsc checked them against the contract. */
const checkedByTsc = (values: object): values is Environment => typeof values === "object";

/** The resolved object as the `Environment` type. */
function environmentOf(values: unknown): Environment {
  if (
    typeof values !== "object" ||
    values === null ||
    Array.isArray(values) ||
    !checkedByTsc(values)
  ) {
    throw new EnvironmentError(
      EnvironmentErrorCode.NotFound,
      "an environment file must export an object: export const environment: AppEnvironment = { … }",
    );
  }
  return values;
}

/** No values: what tools see while they are only described (`agboss describe` without an environment). */
export const NO_ENVIRONMENT_VALUES: Environment = environmentOf(Object.freeze({}));

/** Every process variable an environment file reads, by field. */
export const environmentVariablesOf = (loaded: LoadedEnvironment): readonly ProcessVariable[] =>
  leavesOf(loaded.values).flatMap(([field, value]): ProcessVariable[] => {
    if (!isProcessValue(value)) return [];
    const isSecret = value instanceof Secret;
    const optional = isOptional(value);
    return [
      {
        variable: variableOf(value),
        field,
        use: isSecret ? VariableUse.Secret : VariableUse.Value,
        required: isSecret || (value.fallback === undefined && !optional),
        optional,
      },
    ];
  });

/** An environment as `agboss describe` shows it: its values (missing ones unset) and printable fields. */
export interface DescribedEnvironment {
  readonly name: string;
  readonly values: Environment;
  /** Field → how it prints: secrets masked, a missing variable named. */
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * How one field prints in `agboss describe`: a literal, a variable's value, `***`, what is missing,
 * or an optional variable that is unset (`<unset OPENROUTER_BASE_URL, optional>`).
 */
function fieldLabel(value: unknown, processEnv: NodeJS.ProcessEnv): string {
  if (value instanceof Secret) {
    const variable = variableOfSecret(value);
    return processValueOf(processEnv, variable) === undefined
      ? `<missing ${variable}>`
      : `${SECRET_MASK} (${variable})`;
  }
  if (!(value instanceof VariableReference)) return JSON.stringify(value);
  const raw = processValueOf(processEnv, value.variable);
  if (raw === undefined) {
    if (value.presence === VariablePresence.Optional) return `<unset ${value.variable}, optional>`;
    return value.fallback === undefined
      ? `<missing ${value.variable}>`
      : JSON.stringify(value.fallback);
  }
  return JSON.stringify(parsed(value, raw) ?? raw);
}

/** An environment file for `agboss describe`: secrets masked, a missing variable shown, nothing fails. */
export function describedEnvironment(
  loaded: LoadedEnvironment,
  processEnv: NodeJS.ProcessEnv,
): DescribedEnvironment {
  const problems = new Problems(loaded);
  const values = mapLeaves(loaded.values, (value, path) =>
    isProcessValue(value) ? resolvedValue(value, path, processEnv, problems) : value,
  );
  const fields = Object.fromEntries(
    leavesOf(loaded.values).map(([field, value]) => [field, fieldLabel(value, processEnv)]),
  );
  return { name: loaded.name, values: environmentOf(values), fields };
}
