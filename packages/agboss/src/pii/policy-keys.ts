import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { OptionalSecretReference, variableOfSecretRef } from "../environments/secret.js";
import { isCustomPolicy, type PiiPolicyMeta } from "./pii-policy.decorator.js";

/**
 * The keys a policy makes tokens with (#1301): its own `secret` and `previousSecret`, read from their
 * process variables when the app starts — else the application's. A missing one fails the start,
 * naming the variable, never a value.
 */

/** What the keys are read from: the process and the application's own keys. */
export interface PolicyKeyParts {
  readonly processEnv: NodeJS.ProcessEnv;
  readonly fieldKey: string;
  readonly previousFieldKey?: string | undefined;
}

const unsetSecret = (meta: PiiPolicyMeta, option: string, variable: string): EnvironmentError =>
  new EnvironmentError({
    code: EnvironmentErrorCode.MissingVariables,
    message: `${variable} is not set (${meta.name}.${option})`,
  });

/** The value of a policy's `secret`: its variable's, or the start fails naming the variable. */
function secretOf(meta: PiiPolicyMeta, ref: SecretRef, env: NodeJS.ProcessEnv): string {
  const variable = variableOfSecretRef(ref);
  const value = env[variable];
  if (value === undefined || value === "") throw unsetSecret(meta, "secret", variable);
  return value;
}

/** The value of a `previousSecret`: `secret.optional(…)` may be unset, any other fails the start. */
function previousSecretOf(
  meta: PiiPolicyMeta,
  ref: SecretRef | OptionalSecretRef,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const variable = variableOfSecretRef(ref);
  const value = env[variable];
  if (value !== undefined && value !== "") return value;
  if (ref instanceof OptionalSecretReference) return undefined;
  throw unsetSecret(meta, "previousSecret", variable);
}

/** The keys a policy makes tokens with: its own `secret` and `previousSecret`, else the application's. */
export function policyKeysOf(
  meta: PiiPolicyMeta,
  parts: PolicyKeyParts,
): { readonly key: string; readonly previousKey: string | undefined } {
  if (isCustomPolicy(meta) || meta.secret === undefined)
    return { key: parts.fieldKey, previousKey: parts.previousFieldKey };
  const { previousSecret } = meta;
  return {
    key: secretOf(meta, meta.secret, parts.processEnv),
    previousKey:
      previousSecret === undefined
        ? undefined
        : previousSecretOf(meta, previousSecret, parts.processEnv),
  };
}
