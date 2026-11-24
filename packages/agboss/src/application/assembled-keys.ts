import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ApplicationOptions } from "./application.js";
import type { AssembledApplication } from "./assemble.js";
import { assembledStorageOf } from "../storage/storage-assembly.js";
import { listedClassesOf } from "./application-rules.js";
import { declaredKeysOf, type DeclaredKeys } from "./key-field-rules.js";

/**
 * The application's key fields as assembled (#120, #825): what its PII and idempotency keys are
 * read from, and the rule that an application whose components can write under a business key names
 * an idempotency key.
 */

/** What an assembled application keeps of its key fields (#120, #825). */
export interface AssembledKeyFields {
  /** `@Application({ piiKeyField })` (#120, #825): the environment field of its PII key. */
  readonly piiKeyField?: string;
  /**
   * The other keys it declares, by field (#825): its model providers' `apiKey`s, the mesh's
   * `signingKey`, the `Secret`s its listed classes read — what no key field may read the variable of.
   */
  readonly otherKeys?: DeclaredKeys;
}

/**
 * Its keys' settings (#120, #825): the policies of every workflow, the field of its PII key and the
 * fields of its idempotency keys.
 */
export const keyFieldsOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "piiPolicies" | "piiKeyField" | "otherKeys"> => ({
  piiPolicies: options.piiPolicies ?? [],
  otherKeys: declaredKeysOf(options, listedClassesOf(options)),
  ...(options.piiKeyField === undefined ? {} : { piiKeyField: options.piiKeyField }),
});

/**
 * `[application.idempotency-key-required]` (#825): a component that can make a business key — it
 * reaches `Idempotency` or a fenced-effect store through its `deps` — in an application whose
 * `@DatabaseStorage` names no `idempotencySecret`: a business key's fingerprint is keyed by it, never an unkeyed digest.
 */
export function idempotencyKeyViolations(
  options: ApplicationOptions,
  workflows: readonly AssembledWorkflow[],
): RuleViolation[] {
  // an application with no storage runs on the in-memory defaults (tests, a first run): a call under
  // a key there fails closed at run time (`IdempotencyError.SecretKeyMissing`), never an unkeyed digest
  const database = assembledStorageOf(options.storage)?.database;
  if (database === undefined || database.meta.idempotencySecret !== undefined) return [];
  const use = workflows.find(
    (workflow) => workflow.businessKeyWriter !== undefined,
  )?.businessKeyWriter;
  if (use === undefined) return [];
  const reaches = use.component === use.writer ? "is" : `reaches ${use.writer.name}, so it`;
  return [
    violation(
      "application.idempotency-key-required",
      `${use.component.name} ${reaches} can write under a business key, whose fingerprint is keyed by the application's idempotency key — name the secret in @DatabaseStorage({ …, idempotencySecret: secret("AGBOSS_IDEMPOTENCY_SECRET") })`,
      [options.name],
    ),
  ];
}
