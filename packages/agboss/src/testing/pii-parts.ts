import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { variableOfSecretRef } from "../environments/secret.js";
import { isModelGuardrail, type LoadedGuardrail } from "../guardrails/loaded.js";
import { isCustomPolicy } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { customCompactionClassesOf } from "../memory/custom-classes.js";
import { compactionKeyOf, guardrailKeyOf, piiPolicyKeyOf } from "./scripted-gateway.js";

/**
 * The PII policies and guardrails of an application under `testWith` (#120): a model detection and
 * a guardrail are scripted like any model (`mockModel(ContactPiiPolicy)`,
 * `mockModel(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }))`), and a PII secret
 * whose variable the test process does not set gets a fixed test key — tests never need a real
 * secret.
 */

import { TEST_PREVIOUS_PSEUDONYM_KEY, TEST_PSEUDONYM_KEY } from "../pii/application-key.js";
import {} from "../application/idempotency-key.js";
import type { TestWithOptions } from "./environment.js";

/** The options of tests whose instances make PII tokens on keys of their own (#334). */
const INSTANCE_KEYED = new WeakSet<TestWithOptions>();

/**
 * Internal (#334, not in `@agboss/core/testing`): `testWith(App, withInstancePiiKeys({ instances: 2 }))` —
 * an application without `piiSecret` runs on a key of each instance, as in production, instead
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

/** The script key of a `@PiiPolicy` with `model` in the application; none for anything else. */
export function piiScriptKeyOf(target: Class, assembled: AssembledApplication): string | undefined {
  if (!policyClassesOf(assembled).includes(target)) return undefined;
  const meta = piiPolicyMetaOf(target);
  if (meta === undefined || isCustomPolicy(meta) || meta.model === undefined) return undefined;
  return piiPolicyKeyOf(meta.name);
}

/**
 * The process variables of the PII keys the test process does not set, with the test key: the
 * policies' own (#778) — a test that sets one keeps it.
 */
export function testPseudonymKeys(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const own = policyClassesOf(assembled).flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.secret === undefined) return [];
    return [
      [variableOfSecretRef(meta.secret), TEST_PSEUDONYM_KEY] as const,
      ...(meta.previousSecret === undefined
        ? []
        : [[variableOfSecretRef(meta.previousSecret), TEST_PREVIOUS_PSEUDONYM_KEY] as const]),
    ];
  });
  return Object.fromEntries(own.filter(([variable]) => (processEnv[variable] ?? "") === ""));
}

/**
 * The process variables a test runs with: the test process's, and the test key in every PII key
 * variable of a policy it does not set — never a missing variable (#778). `createApp` reads the
 * real process only.
 */
export function testKeyedProcessEnvOf(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...processEnv, ...testPseudonymKeys(assembled, processEnv) };
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
    .flatMap((workflow) => workflow.memories?.memories ?? [])
    .find((candidate) => candidate.type === target && candidate.prompt !== "");
  return compaction === undefined ? undefined : compactionKeyOf(compaction.name);
}

/** Whether a class is a custom compaction of the application (#382): its `compact()` calls no model. */
export const isCustomCompactionIn = (target: Class, assembled: AssembledApplication): boolean =>
  assembled.workflows.some((workflow) =>
    customCompactionClassesOf(workflow.memories).includes(target),
  );
