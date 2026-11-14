import { NodeKind } from "../flow/ast.js";
import type { GraphDeps } from "../graph/deps.js";

/**
 * The deps of a workflow of a tree, by name (#263): the given one's, or a child's — light, so the
 * pause seam's notices (`recipientsOf`, read at every transition) load nothing of the frames.
 */

/** The graph deps of a workflow of the tree, by name: the given one's, or a child's (#263). */
export function graphDepsNamed(
  deps: GraphDeps<string>,
  name: string,
): GraphDeps<string> | undefined {
  if (deps.config.name === name) return deps;
  for (const node of deps.graph.nodes.values()) {
    const child = node.kind === NodeKind.Workflow ? deps.childDepsOf?.(node.component) : undefined;
    const found = child === undefined ? undefined : graphDepsNamed(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The graph deps of the tree's workflow `name`; the given ones when none is so named. */
export const ownDepsOf = (deps: GraphDeps<string>, name: string): GraphDeps<string> =>
  graphDepsNamed(deps, name) ?? deps;
