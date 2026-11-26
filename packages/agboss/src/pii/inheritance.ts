import { ComponentKind } from "../flow/runtime/records.js";
import type { Class } from "../components/injection.js";
import { childClassesOf } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/**
 * The ways into a child workflow (#1150): every static path of `.toWorkflow` / `.forEachItem`
 * / `route` edges from an application's workflows down to it, each with the `@Workflow`-level PII
 * policies of the workflows above it (an agent's or router's own list is never inherited). Read from
 * the decorators only — what assembly checks a child's exclusions and conflicts against, and what
 * `agboss describe` shows; at run time a child inherits its actual chain's policies.
 */

/** One way into a workflow: the workflows above it, root first, and their lists. */
export interface InheritedPii {
  /** The names of the workflows above it, the root first. */
  readonly path: readonly string[];
  /** Every `@Workflow({ piiPolicies })` of `path`, each once. */
  readonly policies: readonly Class[];
}

const unique = (classes: readonly Class[]): Class[] => [...new Set(classes)];

const keyOf = (classes: readonly Class[]): string =>
  classes
    .map((cls) => cls.name)
    .sort()
    .join(",");

interface WorkflowParts {
  readonly name: string;
  readonly policies: readonly Class[];
  readonly children: readonly Class[];
}

function partsOf(workflow: Class): WorkflowParts | undefined {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== ComponentKind.Workflow) return undefined;
  const { options } = declaration;
  return {
    name: options.name,
    policies: options.piiPolicies ?? [],
    children: childClassesOf(options.flow, workflow),
  };
}

/**
 * Every distinct way into each workflow reachable from `roots`, by class: distinct by the policies
 * it inherits (two paths that inherit the same lists are one), the first path found kept for its text.
 */
function inheritanceOf(roots: readonly Class[]): ReadonlyMap<Class, readonly InheritedPii[]> {
  const found = new Map<Class, InheritedPii[]>();
  const seen = new Set<string>();
  const visit = (workflow: Class, path: readonly string[], above: readonly Class[]): void => {
    const parts = partsOf(workflow);
    if (parts === undefined) return;
    const inherited = unique([...above, ...parts.policies]);
    const here = [...path, parts.name];
    for (const child of parts.children) {
      const key = `${parts.name}>${child.name}:${keyOf(inherited)}`;
      // a child already entered with the same inherited lists: the same sets below it
      if (seen.has(key) || here.includes(partsOf(child)?.name ?? "")) continue;
      seen.add(key);
      const ways = found.get(child) ?? [];
      if (!ways.some((way) => keyOf(way.policies) === keyOf(inherited)))
        ways.push({ path: here, policies: inherited });
      found.set(child, ways);
      visit(child, here, inherited);
    }
  };
  for (const root of roots) visit(root, [], []);
  return found;
}

const cache = new WeakMap<readonly Class[], ReadonlyMap<Class, readonly InheritedPii[]>>();

/** The ways into `workflow` from an application's `workflows`; none for a workflow no one launches. */
export function inheritedPiiOf(
  workflows: readonly Class[] | undefined,
  workflow: Class,
): readonly InheritedPii[] {
  if (workflows === undefined) return [];
  const known = cache.get(workflows) ?? inheritanceOf(workflows);
  cache.set(workflows, known);
  return known.get(workflow) ?? [];
}
