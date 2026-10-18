import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { EdgeKind, reachableFrom } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * The graph rules that stay (#272 AC11): a workflow start exists, every node is reachable from a
 * start, and every path ends in a finish or at a shared node (no dead end). Nothing after a finish
 * is found while walking (`walk.ts`).
 */

function noWorkflowStart(context: AnalysisContext): readonly RuleViolation[] {
  if (context.graph.starts.length > 0) return [];
  const message = "the flow has no workflow start — begin a path with start(…) of a @WorkflowStart";
  return [violation("graph.no-workflow-start", message, [])];
}

function unreachableNodes(context: AnalysisContext): readonly RuleViolation[] {
  const { graph } = context;
  if (graph.starts.length === 0) return [];
  const reachable = reachableFrom(graph.starts, graph.edges);
  return [...graph.nodes.keys()]
    .filter((name) => !reachable.has(name))
    .map((name) => {
      const message =
        `${name} is not reachable from any workflow start — lead a path to it, or remove it from ` +
        "the flow";
      return violation("graph.unreachable-node", message, [name]);
    });
}

/** Edges a failure takes, and the edges into a launch's branches: neither continues a path. */
const SIDE_EDGES: ReadonlySet<EdgeKind> = new Set([
  EdgeKind.Error,
  EdgeKind.JoinError,
  EdgeKind.Launch,
]);

/** The branches of launches (#273): entered by launch edges only, their join continues them. */
function branchesOf(context: AnalysisContext): ReadonlySet<string> {
  const entered = new Map<string, boolean>();
  for (const edge of context.graph.edges)
    entered.set(edge.to, (entered.get(edge.to) ?? true) && edge.kind === EdgeKind.Launch);
  return new Set([...entered].filter(([, isBranch]) => isBranch).map(([node]) => node));
}

/**
 * A node other than a finish whose path stops at it: no next step, route or case leaves it (a
 * launch's branch is continued by its join).
 */
function deadEnds(context: AnalysisContext): readonly RuleViolation[] {
  const { graph } = context;
  const leaving = new Set(
    graph.edges.filter((edge) => !SIDE_EDGES.has(edge.kind)).map((edge) => edge.from),
  );
  const branches = branchesOf(context);
  return [...graph.nodes.values()]
    .filter((node) => node.kind !== NodeKind.Finish && !leaving.has(node.name))
    .filter((node) => !branches.has(node.name))
    .map((node) => {
      const message =
        `the path stops at ${node.name} — continue it with .to…(…), or end it with ` +
        ".toFinish(…); every path ends in a finish or at a shared node";
      return violation("graph.dead-end", message, [node.name]);
    });
}

export function graphRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...noWorkflowStart(context), ...unreachableNodes(context), ...deadEnds(context)];
}
