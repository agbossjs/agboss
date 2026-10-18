import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { conflictViolations, piiPolicyMetaOf, policyViolations } from "./policy-checks.js";

/**
 * The PII policies in effect per agent and router (#120): lists add up `@Application` →
 * `@Workflow` → `@Agent` / `@Router`; removal is explicit (`excludePiiPolicies`), and excluding a
 * policy that is not inherited is an assembly error. Logs, traces and events are covered by the
 * application's and the workflow's lists whatever an element excludes. A child workflow gets its
 * own workflow's lists over the application's — never its parent's.
 */

/** One agent's or router's own policy settings. */
export interface PiiElement {
  readonly name: string;
  readonly piiPolicies?: readonly Class[];
  readonly excludePiiPolicies?: readonly Class[];
}

/** The lists of one workflow, by level. */
export interface PiiLevels {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowName: string;
  readonly elements: readonly PiiElement[];
}

/** What assembly decided: each element's policies, the observability list, every class used. */
export interface EffectivePiiPolicies {
  readonly byElement: ReadonlyMap<string, readonly Class[]>;
  /** What logs, traces and events are masked with: the application's and the workflow's lists. */
  readonly observability: readonly Class[];
  /** Every policy class of the workflow (the container creates them). */
  readonly classes: readonly Class[];
  readonly violations: readonly RuleViolation[];
}

const unique = (classes: readonly Class[]): Class[] => [...new Set(classes)];

function notPolicies(classes: readonly Class[], where: string): RuleViolation[] {
  return classes.flatMap((cls) =>
    piiPolicyMetaOf(cls) === undefined
      ? [
          violation(
            "pii.not-a-policy",
            `${where}: ${cls.name || "(anonymous class)"} in piiPolicies is not a @PiiPolicy class`,
            [cls.name],
          ),
        ]
      : [],
  );
}

function elementPolicies(
  element: PiiElement,
  inherited: readonly Class[],
): { readonly policies: Class[]; readonly violations: RuleViolation[] } {
  const excluded = element.excludePiiPolicies ?? [];
  const violations = excluded.flatMap((cls) =>
    inherited.includes(cls)
      ? []
      : [
          violation(
            "pii.exclude-not-inherited",
            `${element.name}: excludePiiPolicies lists ${cls.name}, which neither its application nor its workflow lists`,
            [element.name, cls.name],
          ),
        ],
  );
  const own = element.piiPolicies ?? [];
  const policies = unique([...inherited, ...own]).filter((cls) => !excluded.includes(cls));
  return { policies, violations: [...violations, ...notPolicies(own, element.name)] };
}

/** Each element's policies and every rule they break, all at once. */
export function effectivePiiPolicies(levels: PiiLevels): EffectivePiiPolicies {
  const inherited = unique([...levels.application, ...levels.workflow]);
  const violations: RuleViolation[] = [...notPolicies(inherited, levels.workflowName)];
  const byElement = new Map<string, readonly Class[]>();
  for (const element of levels.elements) {
    const resolved = elementPolicies(element, inherited);
    violations.push(...resolved.violations);
    violations.push(...conflictViolations(element.name, resolved.policies));
    byElement.set(element.name, resolved.policies);
  }
  const classes = unique([...inherited, ...levels.elements.flatMap((e) => e.piiPolicies ?? [])]);
  violations.push(...policyViolations(classes));
  violations.push(...conflictViolations(levels.workflowName, inherited));
  return { byElement, observability: inherited, classes, violations: dedupe(violations) };
}

const dedupe = (violations: readonly RuleViolation[]): RuleViolation[] => {
  const seen = new Set<string>();
  return violations.filter((item) => {
    const key = `${item.code} ${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
