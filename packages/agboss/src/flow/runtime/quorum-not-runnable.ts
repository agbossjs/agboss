import { AGBossError } from "../../core/errors.js";
import type { FlowAnalysis } from "../analyse/analyse.js";
import { launchLabel } from "../analyse/join-groups.js";

/**
 * A workflow with a quorum (#279): `.acceptedBy(…)`, `.joinQuorum(…)` or `.joinQuorumGroups(…)`.
 * The analyser and `agboss check` accept it, but this version's runtime decides no quorum yet
 * (#279 PR 2), so assembly stops here instead of running a launch that would wait for every branch.
 */
export class QuorumNotRunnableError extends AGBossError {
  static override readonly code: string = "flow.quorum-not-runnable";
}

/** Throws `QuorumNotRunnableError` for the first launch with arbiters or a quorum join. */
export function rejectQuorums(analysis: FlowAnalysis): void {
  const quorum = analysis.graph.edges.find(
    (edge) => edge.join?.quorum !== undefined || edge.launch?.acceptedBy !== undefined,
  );
  const launch = quorum?.launch;
  if (launch === undefined) return;
  throw new QuorumNotRunnableError(
    `${analysis.workflow}: ${launchLabel(launch)} — quorums and arbiters are checked (agboss check) but run only from #279 PR 2; this version cannot execute the workflow`,
  );
}
