import type { Class } from "../components/injection.js";
import type { RuleViolation } from "../graph/rule-error.js";
import {
  effectivePiiPolicies,
  type PiiChainSets,
  type PiiElement,
  type PiiExcludes,
} from "./effective-policies.js";
import type { InheritedPii } from "./inheritance.js";
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
  /** A model of no element (a reply interpreter, a compaction): less the workflow's excludes (#1150). */
  readonly model: readonly Class[];
  /** What the workflow and each element remove at the models (#1150): ancestors' policies too. */
  readonly excludes: PiiExcludes;
  /** The sets on each static way into the workflow as a child (#1150): `agboss describe`. */
  readonly chains: readonly PiiChainSets[];
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

/** What one workflow's PII policies are assembled from (#120, #1150). */
export interface PiiSources {
  readonly workflowName: string;
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowExcludes?: readonly Class[] | undefined;
  readonly elements: readonly PiiElement[];
  readonly inherited?: readonly InheritedPii[] | undefined;
}

/** The PII policies of one workflow from its levels (`@Application` → `@Workflow` → elements). */
export function piiAssemblyOf(sources: PiiSources): PiiAssembly {
  const effective = effectivePiiPolicies({
    application: sources.application,
    workflow: sources.workflow,
    workflowName: sources.workflowName,
    elements: sources.elements,
    workflowExcludes: sources.workflowExcludes ?? [],
    inherited: sources.inherited ?? [],
  });
  return {
    pii: {
      byElement: effective.byElement,
      observability: effective.observability,
      model: effective.model,
      excludes: effective.excludes,
      chains: effective.chains,
      classes: effective.classes,
      detectors: detectorsOf(effective.classes),
    },
    violations: effective.violations,
  };
}
