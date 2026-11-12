import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { Secret, variableOfSecret } from "../environments/secret.js";
import type { Environment } from "../flow/generated-types.js";
import type { AssembledKeyFields } from "./assembled-keys.js";

/**
 * No key field reads another key's variable (#825), checked at start, once the environment is read:
 * the assembly rules compare the fields (`[application.pii-key-shared]`,
 * `[application.idempotency-key-shared]`); two fields of the contract given one variable are one key
 * all the same — rotating the provider's key would change every token or fingerprint.
 */

/** Each key field the application names, with what a message calls it. */
const keyFieldsNamed = (keys: AssembledKeyFields): readonly (readonly [string, string])[] =>
  [
    ["piiKeyField", keys.piiKeyField],
    ["idempotencyKeyField", keys.idempotencyKeyField],
    ["previousIdempotencyKeyField", keys.previousIdempotencyKeyField],
  ].flatMap(([option, field]) => (field === undefined ? [] : [[field, option ?? ""] as const]));

/** The variable a field's `Secret` reads; none for a field that holds no `Secret`. */
function variableOf(environment: Environment, field: string): string | undefined {
  const value: unknown = Reflect.get(environment, field);
  return value instanceof Secret ? variableOfSecret(value) : undefined;
}

/** Throws when a key field reads the variable of another key: naming both fields, never a value. */
export function assertKeyVariablesApart(
  application: string,
  keys: AssembledKeyFields,
  environment: Environment,
): void {
  const own = keyFieldsNamed(keys);
  const all = [...own, ...[...(keys.otherKeys ?? new Map<string, string>())]];
  for (const [field, option] of own) {
    const variable = variableOf(environment, field);
    if (variable === undefined) continue;
    const other = all.find(
      ([name]) => name !== field && variableOf(environment, name) === variable,
    );
    if (other === undefined) continue;
    throw new EnvironmentError({
      code: EnvironmentErrorCode.InvalidValue,
      message: `${application}: @Application({ ${option}: "${field}" }) reads ${variable}, as ${other[0]} (${other[1]}) does — give it a variable of its own: rotating the other key would change every value made with this one`,
    });
  }
}
