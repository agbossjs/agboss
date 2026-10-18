import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { declarationOf } from "../../decorators/declaration.js";
import { EdgeKind, reachableFrom, type FlowLaunch } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { walkFlow } from "../walk.js";
import type { AnalysisContext } from "./context.js";

/**
 * A per-item child (#263) that cannot fail softly: no finish of the child is reachable from one of
 * its `.onError` / `.onJoinError` side paths, so one failed item cancels all the others (FailFast) →
 * the warning `[graph.child-without-failure-finish]` (an error under `--strict`). It goes away only
 * by adding such a path to the child; there is no flag to silence it.
 */

/** Whether a finish of the workflow is reachable from one of its side paths. */
function hasFailureFinish(workflow: Class): boolean {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return true;
  const { graph } = walkFlow(declaration.options.flow);
  const caught = graph.edges
    .filter((edge) => edge.kind === EdgeKind.Error || edge.kind === EdgeKind.JoinError)
    .map((edge) => edge.to);
  return [...reachableFrom(caught, graph.edges)].some(
    (name) => graph.nodes.get(name)?.kind === NodeKind.Finish,
  );
}

function launchWarnings(context: AnalysisContext, launch: FlowLaunch): readonly RuleViolation[] {
  if (launch.targetKind !== NodeKind.Workflow) return [];
  return launch.branches.flatMap((branch) => {
    const child = context.graph.nodes.get(branch.node);
    if (child === undefined || hasFailureFinish(child.component)) return [];
    const message =
      `${launchLabel(launch)}: ${child.name} has no finish reachable from an .onError side path — ` +
      "one failed item will cancel all the others (FailFast); to skip failed items, catch errors " +
      "in the child and end at a finish";
    return [
      violation("graph.child-without-failure-finish", message, [launch.launcher, child.name]),
    ];
  });
}

/** The warnings of the workflow's per-item children. */
export function childFailureWarnings(context: AnalysisContext): readonly RuleViolation[] {
  return context.walked.launches.flatMap((launch) => launchWarnings(context, launch));
}
