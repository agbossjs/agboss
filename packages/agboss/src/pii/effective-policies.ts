import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { InheritedPii } from "./inheritance.js";
import { conflictViolations, piiPolicyMetaOf, policyViolations } from "./policy-checks.js";

/**
 * The PII policies in effect per agent and router (#120): lists add up `@Application` →
 * `@Workflow` → `@Agent` / `@Router`; removal is explicit (`excludePiiPolicies`), and excluding a
 * policy that is not inherited is an assembly error. Logs, traces and events are covered by the
 * application's and the workflow's lists whatever an element excludes.
 *
 * A child workflow (#1150) adds to that every `@Workflow` list of the workflows above it: what it
 * inherits along each static way into it (`inherited`, `inheritance.ts`). Its observability is
 * masked by the whole chain — application ∪ root ∪ … ∪ parent ∪ child — always; its models by the
 * chain less what its `@Workflow({ excludePiiPolicies })` and each element's `excludePiiPolicies`
 * remove (an ancestor's policy may be excluded too). Conflicts are checked on every way in.
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
  /** `@Workflow({ excludePiiPolicies })`: removed at its models only (#1150). */
  readonly workflowExcludes?: readonly Class[];
  /** The static ways into the workflow and what each inherits (#1150); none for a root only. */
  readonly inherited?: readonly InheritedPii[];
}

/** The sets of one way into a child workflow (#1150). */
export interface PiiChainSets {
  /** The workflows above it, the root first. */
  readonly path: readonly string[];
  /** Its logs, traces, events and records: application ∪ the path's ∪ its own. */
  readonly observability: readonly Class[];
  /** A model of no element (a reply interpreter, a compaction): the chain less the workflow's excludes. */
  readonly model: readonly Class[];
  readonly byElement: ReadonlyMap<string, readonly Class[]>;
}

/** What each level removes at the models (#1150). */
export interface PiiExcludes {
  readonly workflow: readonly Class[];
  readonly byElement: ReadonlyMap<string, readonly Class[]>;
}

/** What assembly decided: each element's policies, the observability list, every class used. */
export interface EffectivePiiPolicies {
  /** Each element's policies as the workflow runs as a root (none inherited). */
  readonly byElement: ReadonlyMap<string, readonly Class[]>;
  /** What logs, traces and events are masked with: the application's and the workflow's lists. */
  readonly observability: readonly Class[];
  /** The models of no element: `observability` less the workflow's excludes (#1150). */
  readonly model: readonly Class[];
  readonly excludes: PiiExcludes;
  /** The sets on each static way into the workflow (#1150). */
  readonly chains: readonly PiiChainSets[];
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

/** Excludes that name nothing `allowed` holds: `[pii.exclude-not-inherited]`. */
function notInherited(
  where: string,
  excluded: readonly Class[],
  allowed: readonly Class[],
  levels: string,
): RuleViolation[] {
  return excluded.flatMap((cls) =>
    allowed.includes(cls)
      ? []
      : [
          violation(
            "pii.exclude-not-inherited",
            `${where}: excludePiiPolicies lists ${cls.name}, which neither ${levels} lists`,
            [where, cls.name],
          ),
        ],
  );
}

/** The sets of one chain: `above` = the ancestors' lists (none for a root). */
function setsOf(
  levels: PiiLevels,
  above: readonly Class[],
): Pick<PiiChainSets, "observability" | "model" | "byElement"> {
  const excluded = levels.workflowExcludes ?? [];
  const observability = unique([...levels.application, ...above, ...levels.workflow]);
  const model = observability.filter((cls) => !excluded.includes(cls));
  const byElement = new Map<string, readonly Class[]>();
  for (const element of levels.elements) {
    const removed = element.excludePiiPolicies ?? [];
    const own = element.piiPolicies ?? [];
    byElement.set(
      element.name,
      unique([...model, ...own]).filter((cls) => !removed.includes(cls)),
    );
  }
  return { observability, model, byElement };
}

/** Every conflict of one chain's sets, `under` naming the chain (empty for the root). */
function conflictsOf(
  levels: PiiLevels,
  sets: Pick<PiiChainSets, "observability" | "byElement">,
  under: string,
): RuleViolation[] {
  return [
    ...conflictViolations(`${levels.workflowName}${under}`, sets.observability),
    ...[...sets.byElement].flatMap(([name, classes]) =>
      conflictViolations(`${name}${under}`, classes),
    ),
  ];
}

const pathText = (path: readonly string[]): string => ` (under ${path.join(" → ")})`;

/** Each element's policies and every rule they break, all at once. */
export function effectivePiiPolicies(levels: PiiLevels): EffectivePiiPolicies {
  const own = unique([...levels.application, ...levels.workflow]);
  const inherited = levels.inherited ?? [];
  const ancestors = unique(inherited.flatMap((way) => way.policies));
  const violations: RuleViolation[] = [...notPolicies(own, levels.workflowName)];
  const workflowExcludes = levels.workflowExcludes ?? [];
  violations.push(
    ...notInherited(
      levels.workflowName,
      workflowExcludes,
      unique([...levels.application, ...ancestors]),
      "its application nor a workflow that launches it",
    ),
  );
  for (const element of levels.elements) {
    const allowed = unique([...own, ...ancestors]);
    const which = "its application, its workflow nor a workflow that launches it";
    violations.push(
      ...notInherited(element.name, element.excludePiiPolicies ?? [], allowed, which),
    );
    violations.push(...notPolicies(element.piiPolicies ?? [], element.name));
  }
  const root = setsOf(levels, []);
  violations.push(...conflictsOf(levels, root, ""));
  const chains = inherited.map((way) => {
    const sets = setsOf(levels, way.policies);
    violations.push(...conflictsOf(levels, sets, pathText(way.path)));
    return { path: way.path, ...sets };
  });
  const classes = unique([...own, ...levels.elements.flatMap((e) => e.piiPolicies ?? [])]);
  violations.push(...policyViolations(classes));
  const excludes = {
    workflow: workflowExcludes,
    byElement: new Map(
      levels.elements.map((element) => [element.name, element.excludePiiPolicies ?? []]),
    ),
  };
  return {
    byElement: root.byElement,
    observability: own,
    model: root.model,
    excludes,
    chains,
    classes,
    violations: dedupe(violations),
  };
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
