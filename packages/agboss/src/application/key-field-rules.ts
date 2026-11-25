import type { Class } from "../components/injection.js";
import { depsOf } from "../components/container/container.js";
import {
  declaredFieldsOf,
  readingClassesOf,
  secretFieldsReadBy,
} from "../environments/contract.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import type { ApplicationOptions } from "./application.js";

/**
 * The application's key field (#825): `piiKeyField` (the PII tokens' key) names a `Secret` field of
 * the environment, and it is no other key. A key shared with another Secret a class reads is rotated
 * with it: every PII token, or every stored fingerprint, would change with it.
 */

/** The other keys an application declares, by field: who reads each one. */
export type DeclaredKeys = ReadonlyMap<string, string>;

/** Every key the application declares besides its own key fields: the Secrets its listed classes read. */
export function declaredKeysOf(listed: readonly Class[]): DeclaredKeys {
  const keys = new Map<string, string>();
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
  const declared = declaredKeysOf(listed);
  return [...missingFieldViolations(options), ...piiKeySharedViolations(options, declared)];
}
