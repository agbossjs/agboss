import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ApplicationOptions } from "./application.js";
import type { AssembledApplication } from "./assemble.js";
import { assembledStorageOf } from "../storage/storage-assembly.js";

/**
 * The application's keys as assembled (#120, #825, #1321): the rule that an application whose
 * components can write under a business key names an idempotency key (`@DatabaseStorage({ idempotencySecret })`).
 */

/** Its keys' settings (#120): the PII policies of every workflow. */
export const keyFieldsOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "piiPolicies"> => ({
  piiPolicies: options.piiPolicies ?? [],
});

/**
 * `[application.idempotency-key-required]` (#825): a component that can make a business key — it
 * reaches `Idempotency` (`runOnce` / `sendOnce`) or a fenced-effect store through its `deps` — in an
 * application whose `@DatabaseStorage` names no `idempotencySecret`, or that names no storage at
 * all (a test's assembly, or one that runs no effect, excepted): a business key's fingerprint is
 * keyed by it, never an unkeyed digest.
 */
export function idempotencyKeyViolations(
  options: ApplicationOptions,
  workflows: readonly AssembledWorkflow[],
  isExempt = false,
): RuleViolation[] {
  // no `@DatabaseStorage` is no secret either: the application fails at assembly, not at its first
  // keyed call — a test's assembly gets the test's keys for the in-memory defaults
  const database = assembledStorageOf(options.storage)?.database;
  if (database === undefined ? isExempt : database.meta.idempotencySecret !== undefined) return [];
  const use = workflows.find(
    (workflow) => workflow.businessKeyWriter !== undefined,
  )?.businessKeyWriter;
  if (use === undefined) return [];
  const reaches = use.component === use.writer ? "is" : `reaches ${use.writer.name}, so it`;
  return [
    violation(
      "application.idempotency-key-required",
      `${use.component.name} ${reaches} can write under a business key, whose fingerprint is keyed by the application's idempotency key — ${database === undefined ? "declare a @DatabaseStorage and name" : "name"} the secret in @DatabaseStorage({ …, idempotencySecret: secret("AGBOSS_IDEMPOTENCY_SECRET") })`,
      [options.name],
    ),
  ];
}
