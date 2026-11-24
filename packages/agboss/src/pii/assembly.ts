import type { Class } from "../components/injection.js";
import { componentModelOf, type ModelResolver } from "../models/model-resolver.js";
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
  /** The `name` of the `@ModelProvider` the cascade resolved it to (#1313). */
  readonly modelProvider?: string;
  /** The provider has no `cost`: its calls are `CostSource.Unpriced` (#1313). */
  readonly unpriced?: true;
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

const detectorsOf = (classes: readonly Class[], resolver?: ModelResolver): PiiDetectorUse[] =>
  classes.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.detectWithModel === undefined) return [];
    // its model through the cascade: the policy's own provider, its workflow's, its application's (#1313)
    const own = { model: meta.detectWithModel, provider: meta.modelProvider };
    return [{ name: meta.name, ...componentModelOf(resolver, `pii.${meta.name}`, own) }];
  });

/** What one workflow's PII policies are assembled from (#120, #1150). */
export interface PiiSources {
  readonly workflowName: string;
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowExcludes?: readonly Class[] | undefined;
  readonly elements: readonly PiiElement[];
  readonly inherited?: readonly InheritedPii[] | undefined;
  /** Resolves each detection model through the model cascade (#1313); none: as written. */
  readonly resolver?: ModelResolver | undefined;
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
      detectors: detectorsOf(effective.classes, sources.resolver),
    },
    violations: effective.violations,
  };
}
