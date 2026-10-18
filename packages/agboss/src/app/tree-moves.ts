import { ResumeReason } from "../core/observability.js";
import type { ExecutionTreeRepository } from "../infrastructure/execution-tree.repository.js";
import { PauseStatus } from "../infrastructure/paused-execution.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { recoveryPassOf, resumePassOf, RootCalls } from "./recovery-pass.js";
import { runningOutcome } from "../run/execute.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { AgentExecutionOutput, RunDeps } from "../run/types.js";
import type { AppDeps } from "./app-deps.js";
import { currentOutputOf } from "./current-output.js";
import type { ExecutionLeases, HeldExecutionLease } from "./execution-leases.js";
import { LeasedCheckpointSaver } from "./leased-checkpointer.js";
import { isHandedOver } from "./handed-over.js";
import type { LiveRuns, TreeCall } from "./live-runs.js";
import type { PausedRunBook } from "./paused-runs.js";
import { runResultOf } from "./result.js";
import { executionEventAt, observeLeg, type ObservedExecution } from "./run-events.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";

/**
 * Moving an execution tree under its lease (#265, Q58; the concurrent resumes of #267): one pass
 * at a time per tree on any instance; before the holder lets the tree rest paused it takes the
 * decisions resolved meanwhile (the drain), so no recorded decision waits for another call. A
 * resume whose decision a holder took returns the tree's current output. Tree keys are removed
 * when the tree finishes or fails; a lost lease or an interruption leaves everything to the next
 * holder — recovery (#265 S30), which continues a `running` tree from its last checkpoint.
 */

/** One pass of the tree: the run deps it moves with (its leased checkpointer) and its signal. */
export type TreePass = (
  deps: RunDeps<string>,
  signal: AbortSignal,
) => Promise<AgentExecutionOutput>;

/** What moving a tree needs from its workflow's app. */
export interface TreeMoveParts {
  readonly deps: AppDeps;
  readonly live: LiveRuns;
  readonly paused: PausedRunBook;
  readonly leases: ExecutionLeases;
  readonly trees: ExecutionTreeRepository;
}

export type { TreeCall } from "./live-runs.js";

/** The tree of an execution: its id, thread, tenant and the version it started on (its events). */
export type TreeState = ObservedExecution;

export interface TreeMoves {
  /** A new tree's first pass (`app.execute`) under its lease, then the drain. */
  first(state: TreeState, call: TreeCall, pass: TreePass): Promise<ExecutionOutput>;
  /** A resume's second phase: the tree's lease (waiting while another call holds it), then its decisions. */
  resumed(run: AgentExecutionOutput, call: TreeCall): Promise<ExecutionOutput>;
  /**
   * Recovery (#265 S30): an interrupted tree's lease when it is free, then its pass from its last
   * checkpoint (its resolved pause first); `undefined` when another holds it or it ended meanwhile.
   */
  recovered(interrupted: InterruptedRun, call: TreeCall): Promise<ExecutionOutput | undefined>;
}

/** The run deps of one pass: its checkpoint writes renew the tree's lease first. */
const leasedDeps = (deps: AppDeps, lease: HeldExecutionLease): AppDeps =>
  deps.pause === undefined
    ? deps
    : {
        ...deps,
        pause: { checkpointer: new LeasedCheckpointSaver(deps.pause.checkpointer, lease) },
      };

/** The tree's key in the stores: its tenant and its root execution. */
const treeOf = (state: TreeState) => ({ tenantId: state.tenantId, rootExecutionId: state.runId });


class TreeMover implements TreeMoves {
  /** The roots a resume of this instance is moving or about to move: its own sweep leaves them. */
  readonly #resuming = new RootCalls();

  constructor(private readonly parts: TreeMoveParts) {}

  async first(state: TreeState, call: TreeCall, pass: TreePass): Promise<ExecutionOutput> {
    return this.drained(state, call, await this.parts.leases.hold(treeOf(state)), pass);
  }

  async resumed(run: AgentExecutionOutput, call: TreeCall): Promise<ExecutionOutput> {
    const { deps, paused, leases } = this.parts;
    const state = {
      runId: run.runId,
      threadId: run.threadId,
      tenantId: run.tenantId,
      startedVersion: run.startedVersion ?? deps.config.version,
    };
    const leaving = this.#resuming.enter(run.runId);
    try {
      // answered: the tree has work again — its record is `running` until it rests (#265 S30); only
      // while it is still `paused`: a holder that took the decision meanwhile may have ended it (S66 h)
      await deps.terns.completeIfStatus(
        run.ternId,
        ExecutionRecordStatus.Paused,
        runningOutcome(run.path, run.cost.totalUsd),
      );
      const lease = await leases.hold(treeOf(state), call.signal);
      const stored = await paused.find(state).catch(async (error: unknown) => {
        await lease.release();
        throw error;
      });
      if (stored?.status !== PauseStatus.Resolved || stored.run.runId !== run.runId) {
        await lease.release();
        return await currentOutputOf(deps, paused, state);
      }
      await this.announce(ResumeReason.Answered, stored.decision, state);
      return await this.drained(state, call, lease, resumePassOf(stored, call));
    } finally {
      leaving();
    }
  }

  async recovered(
    interrupted: InterruptedRun,
    call: TreeCall,
  ): Promise<ExecutionOutput | undefined> {
    if (this.#resuming.has(interrupted.runId)) return undefined;
    const { runId, threadId, tenantId, startedVersion } = interrupted;
    const state = { runId, threadId, tenantId, startedVersion };
    const lease = await this.parts.leases.tryHold(treeOf(state));
    if (lease === undefined) return undefined;
    const recovery = await recoveryPassOf(this.parts, interrupted, call).catch(
      async (error: unknown) => {
        await lease.release();
        throw error;
      },
    );
    if (recovery === undefined) {
      await lease.release();
      return undefined;
    }
    const text = `execution ${state.runId} is recovered: it continues from its last checkpoint`;
    const subject = { executionId: state.runId, tenantId: state.tenantId };
    this.parts.deps.log.warn("execution.recovered", text, subject);
    await this.announce(ResumeReason.Recovered, recovery.decision, state);
    return this.drained(state, call, lease, recovery.pass);
  }

  private announce(reason: ResumeReason, decision: unknown, state: TreeState): Promise<void> {
    const event = executionEventAt(state, this.parts.deps.config);
    return this.parts.deps.observer.onExecutionResume({ ...event, reason, decision });
  }

  /** Passes until the tree finishes or rests paused with nothing resolved; the lease released at the end. */
  private async drained(
    state: TreeState,
    call: TreeCall,
    lease: HeldExecutionLease,
    pass: TreePass,
  ): Promise<ExecutionOutput> {
    const { paused } = this.parts;
    try {
      let result = await this.observedPass(state, call, lease, pass);
      for (;;) {
        if (result.status !== ExecutionStatus.Paused) break;
        const stored = await paused.find(state);
        if (stored?.status !== PauseStatus.Resolved) break;
        await this.announce(ResumeReason.Answered, stored.decision, state);
        result = await this.observedPass(state, call, lease, resumePassOf(stored, call));
      }
      if (result.status === ExecutionStatus.Finished) await this.forget(state);
      return result;
    } catch (error) {
      if (!isHandedOver(error)) await this.forget(state);
      throw error;
    } finally {
      await lease.release();
    }
  }

  /** One pass, observed and settled while the lease is held. */
  private observedPass(
    state: TreeState,
    call: TreeCall,
    lease: HeldExecutionLease,
    pass: TreePass,
  ): Promise<ExecutionOutput> {
    const { deps, live, paused } = this.parts;
    const caller = call.signal === undefined ? [lease.signal] : [call.signal, lease.signal];
    const moving = leasedDeps(deps, lease);
    return observeLeg(deps.observer, executionEventAt(state, deps.config), async () => {
      const run = await live.track(state, AbortSignal.any(caller), (signal) =>
        pass(moving, signal),
      );
      await paused.settle(run);
      return runResultOf(run, call.record === true);
    });
  }

  private forget(state: TreeState): Promise<void> {
    return this.parts.trees.deleteAllInTree(treeOf(state));
  }
}

export const treeMovesOf = (parts: TreeMoveParts): TreeMoves => new TreeMover(parts);
