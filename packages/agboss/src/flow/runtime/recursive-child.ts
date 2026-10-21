import type { GraphDeps } from "../../graph/deps.js";
import type { ExecutionGraph } from "./build.js";
import type { ChildGraph } from "./child.js";
import { workflowIdentityOf } from "./workflow-keys.js";

/**
 * `ThisWorkflow` in the compiled graph (#264): the node runs the workflow's own graph, read when its
 * step runs — set once the graph is compiled — and is never its own subgraph (a graph cannot contain
 * itself, #263 S37); Studio shows it as a node marked `recursive: maxDepth N`.
 */

/** The workflow's own compiled graph, set once it is compiled: what `ThisWorkflow` runs (#264). */
export interface OwnGraph {
  graph?: ExecutionGraph;
}

/** `ThisWorkflow`: the workflow again, on its own deps, its graph read when the step runs. */
export function recursiveChildOf(deps: GraphDeps<string>, self: OwnGraph): ChildGraph {
  const { name } = deps.config;
  return {
    deps,
    workflow: workflowIdentityOf(deps),
    isRecursive: true,
    get graph(): ExecutionGraph {
      if (self.graph === undefined)
        throw new TypeError(`${name}: ThisWorkflow ran before its graph was compiled`);
      return self.graph;
    },
  };
}

/** The options of a node of the graph: a child's subgraph, or the recursive node's mark. */
export interface NodeOptions {
  readonly subgraphs?: ExecutionGraph[];
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A child workflow's graph is its node's subgraph: Studio draws it inside the parent (S37);
 * `ThisWorkflow` is a node marked `recursive: maxDepth N` instead (#264, a graph cannot contain itself).
 */
export function nodeOptionsOf(child: ChildGraph | undefined, deps: GraphDeps<string>): NodeOptions {
  if (child === undefined) return {};
  if (!child.isRecursive) return { subgraphs: [child.graph] };
  const maxDepth = deps.graph.analysis.recursion?.maxDepth;
  return { metadata: { recursive: `maxDepth ${String(maxDepth)}` } };
}
