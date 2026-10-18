import type { Class } from "../components/injection.js";
import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { variableOfSecret } from "../environments/secret.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { AssembledPii } from "./assembly.js";
import { isCustomPolicy, type PiiPolicyMeta } from "./pii-policy.decorator.js";
import { piiPolicyMetaOf } from "./policy-checks.js";
import { PiiPolicySet, type SensitiveValue } from "./policy-set.js";
import { runtimePolicyOf, type ModelDetection, type RuntimePiiPolicy } from "./runtime-policy.js";
import { sensitiveValuesOf } from "./sensitive-values.js";
import { observabilityMaskOf, type ObservabilityMask } from "./observability-mask.js";

/**
 * A workflow's PII policies at run time (#120): the instances from the container with their keys
 * (each `pseudonymKey` read from its process variable when the app starts — a missing one fails the
 * start, naming it), the set at each agent's and router's model, and the observability set.
 */
export interface PiiRuntime {
  /** The policies at an agent's or a router's model (application + workflow + own − excluded). */
  readonly policiesOf: (element: string) => PiiPolicySet;
  /** Logs, traces, events and the record: the application's and the workflow's lists. */
  readonly observability: ObservabilityMask;
  /** The values of an execution's contexts marked `sensitive` (#120 AC13). */
  readonly contextValuesOf: (contexts: ExecutionContextValues) => readonly SensitiveValue[];
  /** The key of the tokens of `sensitive` fields. */
  readonly fieldKey: string;
}

/** What the runtime is built from: the container, the process, models and the contexts. */
export interface PiiRuntimeParts {
  readonly resolve: (cls: Class) => unknown;
  readonly processEnv: NodeJS.ProcessEnv;
  /** The model detection of a policy on its `detectWithModel` model. */
  readonly detectionOf: (policy: string, model: string) => ModelDetection;
  readonly contexts: Pick<RuntimeContexts, "tenantContext" | "executionContext">;
  /**
   * The application's key (`@Application({ pseudonymKey })`, #120): tokens no policy key covers —
   * sensitive fields, a project's detectors, a policy without its own key.
   */
  readonly fieldKey: string;
}

function keyOf(meta: PiiPolicyMeta, parts: PiiRuntimeParts): string {
  if (isCustomPolicy(meta) || meta.pseudonymKey === undefined) return parts.fieldKey;
  const variable = variableOfSecret(meta.pseudonymKey);
  const value = parts.processEnv[variable];
  if (value === undefined || value === "")
    throw new EnvironmentError(
      EnvironmentErrorCode.MissingVariables,
      `${variable} is not set (${meta.name}.pseudonymKey)`,
    );
  return value;
}

function runtimePoliciesOf(
  pii: AssembledPii,
  parts: PiiRuntimeParts,
): ReadonlyMap<Class, RuntimePiiPolicy> {
  return new Map(
    pii.classes.flatMap((cls) => {
      const meta = piiPolicyMetaOf(cls);
      if (meta === undefined) return [];
      const model = isCustomPolicy(meta) ? undefined : meta.detectWithModel;
      const policy = runtimePolicyOf({
        meta,
        instance: parts.resolve(cls),
        key: keyOf(meta, parts),
        ...(model === undefined ? {} : { detectWithModel: parts.detectionOf(meta.name, model) }),
      });
      return [[cls, policy] as const];
    }),
  );
}

/** The runtime of a workflow's policies; none listed anywhere → every set is empty. */
export function piiRuntimeOf(pii: AssembledPii | undefined, parts: PiiRuntimeParts): PiiRuntime {
  const policies: ReadonlyMap<Class, RuntimePiiPolicy> =
    pii === undefined ? new Map() : runtimePoliciesOf(pii, parts);
  const setOf = (classes: readonly Class[]): PiiPolicySet =>
    new PiiPolicySet(
      classes.flatMap((cls) => policies.get(cls) ?? []),
      parts.fieldKey,
    );
  const sets = new Map(
    [...(pii?.byElement ?? [])].map(([name, classes]) => [name, setOf(classes)]),
  );
  const none = setOf([]);
  return {
    policiesOf: (element) => sets.get(element) ?? none,
    observability: observabilityMaskOf(setOf(pii?.observability ?? []), parts.contexts),
    fieldKey: parts.fieldKey,
    contextValuesOf: (contexts) =>
      sensitiveValuesOf([
        { type: parts.contexts.tenantContext, values: contexts.tenant },
        { type: parts.contexts.executionContext, values: contexts.execution },
      ]),
  };
}
