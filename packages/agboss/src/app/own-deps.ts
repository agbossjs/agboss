import { NodeKind } from "../flow/ast.js";
import type { GraphDeps } from "../graph/deps.js";
import { inChainOf } from "./pii-chain.js";

/**
 * The deps of a workflow of a tree, by name (#263): the given one's, or a child's — light, so the
 * pause seam's notices (`recipientsOf`, read at every transition) load nothing of the frames. A
 * child's are its own under its parent's chain of PII policies (#1150); a workflow the tree reaches
 * on two ways that inherit different policies gets every one of them (fail closed: a pause names its
 * workflow, not its way).
 */

const policyNamesOf = (deps: GraphDeps<string>): string =>
  (deps.pii?.observed.policies ?? [])
    .map((policy) => policy.name)
    .sort()
    .join(",");

/** Every deps named `name` in the tree below `deps`, each way once. */
function allNamed(deps: GraphDeps<string>, name: string, found: GraphDeps<string>[]): void {
  if (deps.config.name === name) {
    found.push(deps);
    return;
  }
  for (const node of deps.graph.nodes.values()) {
    const child = node.kind === NodeKind.Workflow ? deps.childDepsOf?.(node.component) : undefined;
    if (child !== undefined) allNamed(child, name, found);
  }
}

/** The graph deps of a workflow of the tree, by name: the given one's, or a child's (#263). */
export function graphDepsNamed(
  deps: GraphDeps<string>,
  name: string,
): GraphDeps<string> | undefined {
  const found: GraphDeps<string>[] = [];
  allNamed(deps, name, found);
  const [first, ...others] = found;
  if (first === undefined) return undefined;
  const key = policyNamesOf(first);
  const more = others.filter((other) => policyNamesOf(other) !== key);
  if (more.length === 0) return first;
  const inherited = more.flatMap((other) => other.pii?.observed.policies ?? []);
  return inChainOf(first, inherited, (workflow) => first.childDepsOf?.(workflow));
}

/** The graph deps of the tree's workflow `name`; the given ones when none is so named. */
export const ownDepsOf = (deps: GraphDeps<string>, name: string): GraphDeps<string> =>
  graphDepsNamed(deps, name) ?? deps;
