import type { BranchRecord, QuorumGroupRecord } from "../runtime/launch/records.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * A quorum join decided (#279, `onQuorumDecided`): once per quorum join, when its launch is read —
 * whether it was reached, every branch with what became of its answer (counted with its
 * `acceptedSequence`, rejected with the arbiters that rejected it, surplus, or no verdict for a
 * cancelled, failed or skipped branch) and, for `.joinQuorumGroups(…)`, the group that won. Plain
 * data, no answer values; `step` is the launching step.
 */
export interface QuorumDecidedEvent extends NodeEvent {
  /** `${executionId}:${nodeId}:${visitNumber}` of the launching step (`result.launches`). */
  readonly launch: string;
  /** Whether the execution goes on along the quorum's path (else `QuorumNotReachedError`). */
  readonly isReached: boolean;
  /** Every launched branch, in the launch's order. */
  readonly branches: readonly BranchRecord[];
  /** `.joinQuorumGroups(…)`: the winning group. */
  readonly group?: QuorumGroupRecord;
}
