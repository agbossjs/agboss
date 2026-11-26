import { OptionalSecretReference, Secret, variableOfSecret } from "./secret.js";
import { VariablePresence, VariableReference } from "./variables.js";

/**
 * A process variable a `defineEnv` reference reads (#1324b): its name, how it is used and whether it
 * is required — what `agboss check` lists for an application, never a value.
 */

/** How a variable is printed: a value, or a secret (masked). */
export enum VariableUse {
  Value = "value",
  Secret = "secret",
}

/** A process variable an application reads. */
export interface ProcessVariable {
  readonly variable: string;
  /** Where it is read: the component and the option (`SalesStorage.driver.settings.path`). */
  readonly field: string;
  readonly use: VariableUse;
  /** Whether it is required (no default, not optional); a secret always is. */
  readonly required: boolean;
  /** Whether unset is no value (`env.optional("X")`): neither required nor defaulted. */
  readonly optional: boolean;
}

/** A reference that reads a process variable: `env(…)`, `secret(…)` or `secret.optional(…)`. */
export type ProcessValue = VariableReference | Secret | OptionalSecretReference;

/** The process variable one reference reads: a value or a secret, required, defaulted or optional. */
export function processVariableOf(field: string, value: ProcessValue): ProcessVariable {
  if (value instanceof OptionalSecretReference)
    return {
      variable: value.variable,
      field,
      use: VariableUse.Secret,
      required: false,
      optional: true,
    };
  if (value instanceof Secret)
    return {
      variable: variableOfSecret(value),
      field,
      use: VariableUse.Secret,
      required: true,
      optional: false,
    };
  const optional = value.presence === VariablePresence.Optional;
  return {
    variable: value.variable,
    field,
    use: VariableUse.Value,
    required: value.fallback === undefined && !optional,
    optional,
  };
}
