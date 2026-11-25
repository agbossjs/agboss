/**
 * The two failures of a quorum (#279): an arbiter could not judge an answer (`StepError.Arbiter`) — not a
 * rejection, it fails the launch — and the quorum was not reached (`StepError.QuorumNotReached`): too few
 * answers counted, or no group complete, by the deadline or once it could no longer be. Both are
 * step failures (`StepError`), taken by `.onError(E, …)` right after the join; without
 * one the execution fails.
 */

/** How far a quorum got: what it needed and what it counted. */
export interface QuorumShortfall {
  /** `.joinQuorum({ min })`; undefined for `.joinQuorumGroups(…)`. */
  readonly min?: number | undefined;
  /** How many answers were counted. */
  readonly counted: number;
  /** Why it stopped: `the deadline passed`, `min can no longer be reached`, … */
  readonly reason: string;
  /**
   * The node ids (`critic-agent#2`, with `[itemIndex]` for a per-item launch) of its branches that
   * ended `Expired` (#945): their pause passed its deadline; they did not vote. Default: none.
   */
  readonly expired?: readonly string[];
}
