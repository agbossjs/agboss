import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ApplicationOptions } from "./application.js";
import type { AssembledApplication } from "./assemble.js";
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
  /** `@Application({ idempotencyKeyField })` (#825): the field of its business-key fingerprints' key. */
  readonly idempotencyKeyField?: string;
  /** `@Application({ previousIdempotencyKeyField })` (#825): the key it rotates from. */
  readonly previousIdempotencyKeyField?: string;
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
): Pick<
  AssembledApplication,
  | "piiPolicies"
  | "piiKeyField"
  | "idempotencyKeyField"
  | "previousIdempotencyKeyField"
  | "otherKeys"
> => ({
  piiPolicies: options.piiPolicies ?? [],
  otherKeys: declaredKeysOf(options, listedClassesOf(options)),
  ...(options.piiKeyField === undefined ? {} : { piiKeyField: options.piiKeyField }),
  ...(options.idempotencyKeyField === undefined
    ? {}
    : { idempotencyKeyField: options.idempotencyKeyField }),
  ...(options.previousIdempotencyKeyField === undefined
    ? {}
    : { previousIdempotencyKeyField: options.previousIdempotencyKeyField }),
});

/**
 * `[application.idempotency-key-required]` (#825): a component that can make a business key — it
 * reaches `OutboundCalls` or a fenced-effect store through its `deps` — in an application that names
 * no `idempotencyKeyField`: a business key's fingerprint is keyed by it, never an unkeyed digest.
 */
export function idempotencyKeyViolations(
  options: ApplicationOptions,
  workflows: readonly AssembledWorkflow[],
): RuleViolation[] {
  if (options.idempotencyKeyField !== undefined) return [];
  const use = workflows.find(
    (workflow) => workflow.businessKeyWriter !== undefined,
  )?.businessKeyWriter;
  if (use === undefined) return [];
  const reaches = use.component === use.writer ? "is" : `reaches ${use.writer.name}, so it`;
  return [
    violation(
      "application.idempotency-key-required",
      `${use.component.name} ${reaches} can write under a business key, whose fingerprint is keyed by the application's idempotency key — name a Secret field of the environment: @Application({ idempotencyKeyField: "idempotencyKey" }) with idempotencyKey: secret("AGBOSS_IDEMPOTENCY_KEY")`,
      [options.name],
    ),
  ];
}
