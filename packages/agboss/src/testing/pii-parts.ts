import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { variableOfSecret } from "../environments/secret.js";
import { isModelGuardrail, type LoadedGuardrail } from "../guardrails/loaded.js";
import { isCustomPolicy } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { compactionKeyOf, guardrailKeyOf, piiPolicyKeyOf } from "./scripted-gateway.js";

/**
 * The PII policies and guardrails of an application under `testWith` (#120): a model detection and
 * a guardrail are scripted like any model (`mockLlm(ContactPiiPolicy)`,
 * `mockLlm(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }))`), and a `pseudonymKey`
 * whose variable the test process does not set gets a fixed test key — tests never need a real
 * secret.
 */

import { TEST_PSEUDONYM_KEY } from "../pii/application-key.js";
import type { TestWithOptions } from "./environment.js";

/** The options of tests whose instances make PII tokens on keys of their own (#334). */
const INSTANCE_KEYED = new WeakSet<TestWithOptions>();

/**
 * Internal (#334, not in `agboss/testing`): `testWith(App, withInstancePiiKeys({ instances: 2 }))` —
 * an application without `pseudonymKey` runs on a key of each instance, as in production, instead
 * of the test's fixed key: the framework's own tests of keys per execution across instances.
 */
export function withInstancePiiKeys(options: TestWithOptions): TestWithOptions {
  INSTANCE_KEYED.add(options);
  return options;
}

/** The PII key of a test's instances when the application sets none: the fixed test key. */
export const testPiiKeyOf = (options: TestWithOptions): string | undefined =>
  INSTANCE_KEYED.has(options) ? undefined : TEST_PSEUDONYM_KEY;

const policyClassesOf = (assembled: AssembledApplication): readonly Class[] => [
  ...new Set(assembled.workflows.flatMap((workflow) => workflow.pii?.classes ?? [])),
];

/** The script key of a `@PiiPolicy` with `detectWithModel` in the application; none for anything else. */
export function piiScriptKeyOf(target: Class, assembled: AssembledApplication): string | undefined {
  if (!policyClassesOf(assembled).includes(target)) return undefined;
  const meta = piiPolicyMetaOf(target);
  if (meta === undefined || isCustomPolicy(meta) || meta.detectWithModel === undefined)
    return undefined;
  return piiPolicyKeyOf(meta.name);
}

/** The process variables of the policies' keys the test process does not set, with the test key. */
export function testPseudonymKeys(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const variables = policyClassesOf(assembled).flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.pseudonymKey === undefined) return [];
    return [variableOfSecret(meta.pseudonymKey)];
  });
  return Object.fromEntries(
    variables
      .filter((variable) => (processEnv[variable] ?? "") === "")
      .map((variable) => [variable, TEST_PSEUDONYM_KEY]),
  );
}

const guardrailOf = (target: Class, assembled: AssembledApplication): LoadedGuardrail | undefined =>
  assembled.workflows
    .flatMap((workflow) => workflow.guardrails?.guardrails ?? [])
    .find((candidate) => candidate.type === target);

/** The script key of a model guardrail of the application (`guardrail:<name>`); none for anything else. */
export function guardrailScriptKeyOf(
  target: Class,
  assembled: AssembledApplication,
): string | undefined {
  const guardrail = guardrailOf(target, assembled);
  return guardrail === undefined || !isModelGuardrail(guardrail)
    ? undefined
    : guardrailKeyOf(guardrail.name);
}

/** Whether a class is a code guardrail of the application (#383): it has no script. */
export const isCodeGuardrailOf = (target: Class, assembled: AssembledApplication): boolean => {
  const guardrail = guardrailOf(target, assembled);
  return guardrail !== undefined && !isModelGuardrail(guardrail);
};

/**
 * The script key of a `@Compaction` that writes summaries in the application (`compaction:<name>`,
 * #120 PR 3); none for a `None` one or anything else. Unscripted, it writes a fixed summary.
 */
export function compactionScriptKeyOf(
  target: Class,
  assembled: AssembledApplication,
): string | undefined {
  const compaction = assembled.workflows
    .flatMap((workflow) => workflow.compactions?.compactions ?? [])
    .find((candidate) => candidate.type === target && candidate.prompt !== "");
  return compaction === undefined ? undefined : compactionKeyOf(compaction.name);
}
