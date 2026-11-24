import type { Class } from "../components/injection.js";
import { depsOf } from "../components/container/container.js";
import {
  declaredFieldsOf,
  readingClassesOf,
  secretFieldsReadBy,
} from "../environments/contract.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import { OPENROUTER_API_KEY_FIELD } from "../models/jev.provider.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import type { ApplicationOptions } from "./application.js";

/**
 * The application's key field (#825): `piiKeyField` (the PII tokens' key) names a `Secret` field of
 * the environment, and it is no other key. A key shared with a model provider's `apiKey` is rotated with
 * it, routinely, by the provider: every PII token, or every stored fingerprint, would change with it.
 */

/** The other keys an application declares, by field: who reads each one. */
export type DeclaredKeys = ReadonlyMap<string, string>;

/** The `apiKey` fields of the model providers the application's models go through (#266). */
function providerKeysOf(options: ApplicationOptions): readonly (readonly [string, string])[] {
  const listed = (options.providers ?? []).filter(isModelProviderClass);
  // none listed → the built-in OpenRouter providers, on their key field
  if (listed.length === 0)
    return [[OPENROUTER_API_KEY_FIELD, "the built-in OpenRouter providers' apiKey"]];
  return listed.flatMap((cls) => {
    const { apiKey } = modelProviderOf(cls) as { readonly apiKey?: string };
    return apiKey === undefined ? [] : [[apiKey, `${cls.name}'s apiKey`] as const];
  });
}

/** Every key the application declares besides its own key fields: providers', the stores'. */
export function declaredKeysOf(
  options: ApplicationOptions,
  listed: readonly Class[],
): DeclaredKeys {
  const keys = new Map<string, string>(providerKeysOf(options));
  const readers = readingClassesOf(listed, depsOf).map((reading) => reading.reader);
  for (const field of secretFieldsReadBy(readers))
    if (!keys.has(field)) keys.set(field, "a Secret a listed class reads (environmentFields)");
  return keys;
}

/** A key field named and declared by the contract (`[environment.missing-field]` otherwise). */
function missingFieldViolations(options: ApplicationOptions): RuleViolation[] {
  const contract = (options as Partial<ApplicationOptions>).environment;
  const declared = contract === undefined ? [] : declaredFieldsOf(contract);
  const where = contract?.name ?? "the environment contract";
  const named = [["piiKeyField", options.piiKeyField]] as const;
  return named.flatMap(([option, field]) =>
    field === undefined || declared.includes(field)
      ? []
      : [
          violation(
            "environment.missing-field",
            `@Application ${option} needs ${field}: Secret in ${where}`,
            [options.name],
          ),
        ],
  );
}

/** `field`, named by `option`, is also one of `others`: the violation `code`, naming both. */
function sharedViolation(
  options: ApplicationOptions,
  code: RuleCode,
  option: string,
  shared: { readonly field: string; readonly with: string },
): RuleViolation {
  return violation(
    code,
    `@Application ${option} "${shared.field}" is also ${shared.with} — give it a Secret field of its own: rotating the other key would change every value made with this one`,
    [options.name],
  );
}

/** `[application.pii-key-shared]`: the PII key is another key, an idempotency key's too. */
function piiKeySharedViolations(
  options: ApplicationOptions,
  declared: DeclaredKeys,
): RuleViolation[] {
  const field = options.piiKeyField;
  if (field === undefined) return [];
  const shares = declared.get(field);
  if (shares === undefined) return [];
  const code = "application.pii-key-shared";
  return [sharedViolation(options, code, "piiKeyField", { field, with: shares })];
}

/**
 * The key fields' rules (#825): each declared by the contract; the PII key no other key
 * (`[application.pii-key-shared]`).
 */
export function keyFieldViolations(
  options: ApplicationOptions,
  listed: readonly Class[],
): RuleViolation[] {
  const declared = declaredKeysOf(options, listed);
  return [...missingFieldViolations(options), ...piiKeySharedViolations(options, declared)];
}
