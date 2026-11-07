import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { environmentOwnerOf } from "../application/create-app.js";
import {
  namedEnvironmentOf,
  selectedEnvironment,
  TEST_DEFAULT_ENVIRONMENT,
  type EnvironmentSelection,
  type NamedEnvironment,
} from "../environments/load.js";
import type { LoadedEnvironment } from "../environments/resolve.js";
import { isResolvedSecret, Secret, variableOfSecret } from "../environments/secret.js";
import { isModelGuardrail, type LoadedGuardrail } from "../guardrails/loaded.js";
import { isCustomPolicy } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { customCompactionClassesOf } from "../compaction/custom-classes.js";
import { compactionKeyOf, guardrailKeyOf, piiPolicyKeyOf } from "./scripted-gateway.js";

/**
 * The PII policies and guardrails of an application under `testWith` (#120): a model detection and
 * a guardrail are scripted like any model (`mockLlm(ContactPiiPolicy)`,
 * `mockLlm(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }))`), and a `piiKeyField`
 * whose variable the test process does not set gets a fixed test key — tests never need a real
 * secret.
 */

import { TEST_PSEUDONYM_KEY } from "../pii/application-key.js";
import {
  TEST_IDEMPOTENCY_KEY,
  TEST_PREVIOUS_IDEMPOTENCY_KEY,
} from "../application/idempotency-key.js";
import type { TestWithOptions } from "./environment.js";

/** The options of tests whose instances make PII tokens on keys of their own (#334). */
const INSTANCE_KEYED = new WeakSet<TestWithOptions>();

/**
 * Internal (#334, not in `@agboss/core/testing`): `testWith(App, withInstancePiiKeys({ instances: 2 }))` —
 * an application without `piiKeyField` runs on a key of each instance, as in production, instead
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

/** The variable of a key field (#778): its `secret("…")` in the loaded environment, unresolved. */
function keyVariablesOf(
  field: string | undefined,
  loaded: LoadedEnvironment | undefined,
): readonly string[] {
  const values = loaded?.values;
  if (field === undefined || typeof values !== "object" || values === null) return [];
  const value: unknown = Reflect.get(values, field);
  return value instanceof Secret && !isResolvedSecret(value) ? [variableOfSecret(value)] : [];
}

/** The variable of the application's key field (#778): its `secret("…")` in the loaded environment. */
const applicationKeyVariablesOf = (
  assembled: AssembledApplication,
  loaded: LoadedEnvironment | undefined,
): readonly string[] => keyVariablesOf(assembled.piiKeyField, loaded);

/**
 * The idempotency key variables the test process does not set (#825), with the test keys: the
 * current field's `TEST_IDEMPOTENCY_KEY`, the previous one's another — as #778 gives the PII key.
 */
function testIdempotencyKeys(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
  loaded: LoadedEnvironment | undefined,
): Record<string, string> {
  const keyed = [
    ...keyVariablesOf(assembled.idempotencyKeyField, loaded).map(
      (v) => [v, TEST_IDEMPOTENCY_KEY] as const,
    ),
    ...keyVariablesOf(assembled.previousIdempotencyKeyField, loaded).map(
      (v) => [v, TEST_PREVIOUS_IDEMPOTENCY_KEY] as const,
    ),
  ];
  return Object.fromEntries(keyed.filter(([variable]) => (processEnv[variable] ?? "") === ""));
}

/**
 * The process variables of the PII keys the test process does not set, with the test key: the
 * policies' own and the application's `piiKeyField`'s (#778) — a test that sets one keeps it.
 */
export function testPseudonymKeys(
  assembled: AssembledApplication,
  processEnv: NodeJS.ProcessEnv,
  loaded?: LoadedEnvironment,
): Record<string, string> {
  const policies = policyClassesOf(assembled).flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.pseudonymKey === undefined) return [];
    return [variableOfSecret(meta.pseudonymKey)];
  });
  return Object.fromEntries(
    [...policies, ...applicationKeyVariablesOf(assembled, loaded)]
      .filter((variable) => (processEnv[variable] ?? "") === "")
      .map((variable) => [variable, TEST_PSEUDONYM_KEY]),
  );
}

/** A test's environment and process variables, the PII keys it does not set given the test key. */
export interface TestKeyedEnvironment {
  readonly named: NamedEnvironment;
  readonly processEnv: NodeJS.ProcessEnv;
}

/**
 * The environment a test runs on (`test` unless `env` names another), resolved with the test key
 * in every PII key variable the test process does not set — the application's key field resolves
 * like any other, never a missing variable (#778). `createApp` resolves the real process only.
 */
export async function testKeyedEnvironmentOf(
  assembled: AssembledApplication,
  selection: EnvironmentSelection,
  processEnv: NodeJS.ProcessEnv,
): Promise<TestKeyedEnvironment> {
  const owner = environmentOwnerOf(assembled);
  const loaded = await selectedEnvironment(owner, selection.env, TEST_DEFAULT_ENVIRONMENT);
  const keyed = {
    ...processEnv,
    ...testPseudonymKeys(assembled, processEnv, loaded),
    ...testIdempotencyKeys(assembled, processEnv, loaded),
  };
  return { named: namedEnvironmentOf(loaded, keyed), processEnv: keyed };
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

/** Whether a class is a custom compaction of the application (#382): its `compact()` calls no model. */
export const isCustomCompactionIn = (target: Class, assembled: AssembledApplication): boolean =>
  assembled.workflows.some((workflow) =>
    customCompactionClassesOf(workflow.compactions).includes(target),
  );
