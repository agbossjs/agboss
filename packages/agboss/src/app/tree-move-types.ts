import type { ExecutionTreeRepository } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import type { AgentExecutionOutput, AgentExecutionDeps } from "../run/types.js";
import type { AppDeps } from "./app-deps.js";
import type { CancelWatch } from "./cancel-requests.js";
import type { ExecutionLeases, HeldExecutionLease } from "./execution-leases.js";
import type { LiveRuns, TreeCall } from "./live-runs.js";
import type { PausedRunBook } from "./paused-runs.js";
import type { RecordedAnswer } from "./resume.js";
import type { ObservedExecution } from "./run-events.js";
import type { ExecutionOutput } from "./types.js";

/** The types of moving an execution tree (`tree-moves.ts`): types only, nothing loaded. */

export type { TreeCall } from "./live-runs.js";

/** One pass of the tree: the run deps it moves with (its leased checkpointer) and its signal. */
export type TreePass = (
  deps: AgentExecutionDeps<string>,
  signal: AbortSignal,
) => Promise<AgentExecutionOutput>;

/** What moving a tree needs from its workflow's app. */
export interface TreeMoveParts {
  readonly deps: AppDeps;
  readonly live: LiveRuns;
  readonly paused: PausedRunBook;
  readonly leases: ExecutionLeases;
  readonly trees: ExecutionTreeRepository;
  /** The application's clock: when a tree's pauses were cancelled. */
  readonly clock: Clock;
}

/** A pass and the answers it takes (none for a tree's first pass or a recovery from its checkpoint). */
export interface PlannedPass {
  readonly pass: TreePass;
  readonly resume?: TreeResume | undefined;
}

/** What a pass is moved under: the tree's lease and the watch over its cancel request (#360). */
export interface HeldPass {
  readonly lease: HeldExecutionLease;
  readonly watch: CancelWatch;
}

/** A pass that takes recorded answers. */
export interface AnsweredPass extends PlannedPass {
  readonly resume: TreeResume;
}

/** The tree of an execution: its id, thread, tenant and the version it started on (its events). */
export type TreeState = ObservedExecution;

export interface TreeMoves {
  /** A new tree's first pass (`app.execute`) under its lease, then the drain. */
  first(state: TreeState, call: TreeCall, pass: TreePass): Promise<ExecutionOutput>;
  /**
   * A resume's second phase: the tree's lease (waiting while another call holds it), then every
   * decision recorded for its waiting pauses; the tree's current output when a holder took them.
   */
  resumed(answer: RecordedAnswer, call: TreeCall): Promise<ExecutionOutput>;
  /**
   * Recovery (#265 S30): an interrupted tree's lease when it is free, then its pass from its last
   * checkpoint (its resolved pause first); `undefined` when another holds it or it ended meanwhile.
   */
  recovered(interrupted: InterruptedRun, call: TreeCall): Promise<ExecutionOutput | undefined>;
  /**
   * A root with a cancel request (#360) is ended as cancelled when its lease is free, whatever
   * config it started on; `true` when it had one (its holder, if any, ends it).
   */
  endIfCancelled(interrupted: InterruptedRun): Promise<boolean>;
}
