import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { variableOfSecret } from "../environments/secret.js";
import { isCustomPolicy } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { guardrailKeyOf, piiPolicyKeyOf } from "./scripted-gateway.js";

/**
 * The PII policies and guardrails of an application under `testWith` (#120): a model detection and
 * a guardrail are scripted like any model (`mockLlm(ContactPiiPolicy)`,
 * `mockLlm(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }))`), and a `pseudonymKey`
 * whose variable the test process does not set gets a fixed test key — tests never need a real
 * secret.
 */

import { TEST_PSEUDONYM_KEY } from "../pii/application-key.js";

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

/** The script key of a guardrail of the application (`guardrail:<name>`); none for anything else. */
export function guardrailScriptKeyOf(
  target: Class,
  assembled: AssembledApplication,
): string | undefined {
  const guardrail = assembled.workflows
    .flatMap((workflow) => workflow.guardrails?.guardrails ?? [])
    .find((candidate) => candidate.type === target);
  return guardrail === undefined ? undefined : guardrailKeyOf(guardrail.name);
}
