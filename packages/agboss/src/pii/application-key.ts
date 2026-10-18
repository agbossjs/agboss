import type { Class } from "../components/injection.js";
import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { isResolvedSecret, Secret, variableOfSecret } from "../environments/secret.js";
import type { Environment } from "../flow/generated-types.js";
import { PiiActionKind } from "./actions.js";
import { isCustomPolicy } from "./pii-policy.decorator.js";
import { piiPolicyMetaOf } from "./policy-checks.js";

/**
 * The application's PII key (#120, `@Application({ pseudonymKey })`): a `Secret` field of its
 * environment, read when the app starts — the same on every instance, so one value is one token
 * on every machine. A policy that makes tokens without its own key needs it; when it is not set
 * the start fails, naming the field. Without a need and without a key, `sensitive` fields use a
 * key of the instance.
 */

/** The key a test's tokens are made with (`testWith`) when no key is set. */
export const TEST_PSEUDONYM_KEY = "agboss-test-pseudonym-key";

/** Where the key is read: the application's setting, its environment, the process. */
export interface ApplicationKeySource {
  readonly application: string;
  readonly field?: string | undefined;
  readonly environment: Environment;
  readonly env: NodeJS.ProcessEnv;
  /** Every PII policy class of the application's workflows. */
  readonly policies: readonly Class[];
  /** A test's key when the application's is not set (`testWith`): never a failure there. */
  readonly fallback?: string | undefined;
}

/** The policies that make tokens with the application's key: no key of their own. */
export function policiesNeedingTheKey(policies: readonly Class[]): readonly string[] {
  return policies.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined) return [];
    const tokens = isCustomPolicy(meta)
      ? meta.action.kind === PiiActionKind.ReplaceWithToken
      : meta.pseudonymKey === undefined &&
        meta.rules.some((rule) => rule.action.kind === PiiActionKind.ReplaceWithToken);
    return tokens ? [meta.name] : [];
  });
}

const variableIn = (env: NodeJS.ProcessEnv, variable: string): string | undefined => {
  const raw = env[variable];
  return raw === undefined || raw === "" ? undefined : raw;
};

/** The field's secret value; none when the field is unset or not a `Secret`. */
function keyValueOf(source: ApplicationKeySource, field: string): string | undefined {
  const value: unknown = Reflect.get(source.environment, field);
  if (!(value instanceof Secret)) return undefined;
  return isResolvedSecret(value) ? value.reveal() : variableIn(source.env, variableOfSecret(value));
}

/** The application's key; none when it sets none and nothing needs one. */
export function applicationPseudonymKeyOf(source: ApplicationKeySource): string | undefined {
  const key = source.field === undefined ? undefined : keyValueOf(source, source.field);
  if (key !== undefined) return key;
  if (source.fallback !== undefined) return source.fallback;
  const needing = policiesNeedingTheKey(source.policies);
  if (needing.length === 0) return undefined;
  const fix =
    source.field === undefined
      ? `set @Application({ pseudonymKey: "piiPseudonymKey" }) with piiPseudonymKey: secret("…") in the environment`
      : `the environment has no ${source.field} — set ${source.field}: secret("…")`;
  throw new EnvironmentError(
    EnvironmentErrorCode.MissingVariables,
    `${source.application}: ${needing.join(", ")} make tokens with the application's PII key — ${fix}`,
  );
}
