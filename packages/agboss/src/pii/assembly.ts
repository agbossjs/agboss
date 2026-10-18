import type { Class } from "../components/injection.js";
import type { RuleViolation } from "../graph/rule-error.js";
import { effectivePiiPolicies, type PiiElement } from "./effective-policies.js";
import { isCustomPolicy } from "./pii-policy.decorator.js";
import { piiPolicyMetaOf } from "./policy-checks.js";

/** A policy's model detection as a model use (`pii.<name>`), checked against the providers (#266). */
export interface PiiDetectorUse {
  readonly name: string;
  readonly model: string;
}

/** A workflow's PII policies as assembled (#120): classes only — the container creates them. */
export interface AssembledPii {
  /** Each agent's and router's policies (application + workflow + own − excluded). */
  readonly byElement: ReadonlyMap<string, readonly Class[]>;
  /** The application's and the workflow's lists: logs, traces, events and the record. */
  readonly observability: readonly Class[];
  /** Every policy class of the workflow. */
  readonly classes: readonly Class[];
  /** The policies with `detectWithModel`. */
  readonly detectors: readonly PiiDetectorUse[];
}

/** What the levels give one workflow, and the rules they break. */
export interface PiiAssembly {
  readonly pii: AssembledPii;
  readonly violations: readonly RuleViolation[];
}

const detectorsOf = (classes: readonly Class[]): PiiDetectorUse[] =>
  classes.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.detectWithModel === undefined) return [];
    return [{ name: meta.name, model: meta.detectWithModel }];
  });

/** The PII policies of one workflow from its levels (`@Application` → `@Workflow` → elements). */
export function piiAssemblyOf(
  workflowName: string,
  application: readonly Class[],
  workflow: readonly Class[],
  elements: readonly PiiElement[],
): PiiAssembly {
  const effective = effectivePiiPolicies({ application, workflow, workflowName, elements });
  return {
    pii: {
      byElement: effective.byElement,
      observability: effective.observability,
      classes: effective.classes,
      detectors: detectorsOf(effective.classes),
    },
    violations: effective.violations,
  };
}
