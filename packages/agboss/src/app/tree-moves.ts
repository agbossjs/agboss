import { ResumeReason } from "../core/observability.js";
import type { ExecutionTreeRepository } from "../infrastructure/execution-tree.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { recoveryPassOf, resumePassOf, RootCalls } from "./recovery-pass.js";
import { runningOutcome } from "../run/execute.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import type { AgentExecutionOutput, RunDeps } from "../run/types.js";
import type { AppDeps } from "./app-deps.js";
import { currentOutputOf } from "./current-output.js";
import type { ExecutionLeases, HeldExecutionLease } from "./execution-leases.js";
import { LeasedCheckpointSaver } from "./leased-checkpointer.js";
import { isHandedOver } from "./handed-over.js";
import type { LiveRuns, TreeCall } from "./live-runs.js";
import { withdrawPauses, type PausedRunBook } from "./paused-runs.js";
import type { RecordedAnswer } from "./resume.js";
import { announceResume, markTaken, treeResumeNow } from "./tree-resume.js";
import { maskedRecordOf, runResultOf, withPauseAnswers } from "./result.js";
import { executionEventAt, observeLeg, type ObservedExecution } from "./run-events.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import type { Clock } from "../infrastructure/clock.js";

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
  /** The application's clock: when a tree's pauses were cancelled. */
  readonly clock: Clock;
}

export type { TreeCall } from "./live-runs.js";

/** A pass and the answers it takes (none for a tree's first pass or a recovery from its checkpoint). */
interface PlannedPass {
  readonly pass: TreePass;
  readonly resume?: TreeResume | undefined;
}

/** A pass that takes recorded answers. */
interface AnsweredPass extends PlannedPass {
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
}

/** The run deps of one pass: its checkpoint writes renew the tree's lease first. */
const leasedDeps = (deps: AppDeps, lease: HeldExecutionLease): AppDeps =>
  deps.pause === undefined
    ? deps
    : {
        ...deps,
        pause: {
          ...deps.pause,
          checkpointer: new LeasedCheckpointSaver(deps.pause.checkpointer, lease),
        },
      };

/** The tree's key in the stores: its tenant and its root execution. */
const treeOf = (state: TreeState) => ({ tenantId: state.tenantId, rootExecutionId: state.runId });

class TreeMover implements TreeMoves {
  /** The roots a resume of this instance is moving or about to move: its own sweep leaves them. */
  readonly #resuming = new RootCalls();

  constructor(private readonly parts: TreeMoveParts) {}

  async first(state: TreeState, call: TreeCall, pass: TreePass): Promise<ExecutionOutput> {
    return this.drained(state, call, await this.parts.leases.hold(treeOf(state)), { pass });
  }

  async resumed(answer: RecordedAnswer, call: TreeCall): Promise<ExecutionOutput> {
    const { deps, paused, leases } = this.parts;
    const { pause, run } = answer;
    const state = {
      runId: pause.rootExecutionId,
      threadId: pause.threadId,
      tenantId: pause.tenantId,
      startedVersion: run?.startedVersion ?? deps.config.version,
    };
    const leaving = this.#resuming.enter(state.runId);
    try {
      // answered: the tree has work again — its record is `running` until it rests (#265 S30); only
      // while it is still `paused`: a holder that took the decision meanwhile may have ended it (S66 h)
      if (run !== undefined) {
        await deps.terns.completeIfStatus(
          run.ternId,
          ExecutionRecordStatus.Paused,
          runningOutcome(run.path, run.cost.totalUsd),
        );
      }
      const lease = await leases.hold(treeOf(state), call.signal);
      const next = await this.nextPass(state, call).catch(async (error: unknown) => {
        await lease.release();
        throw error;
      });
      if (next === undefined) {
        await lease.release();
        return await currentOutputOf(deps, paused, state);
      }
      await this.announce(ResumeReason.Answered, next.resume, state);
      return await this.drained(state, call, lease, next);
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
    await this.announce(ResumeReason.Recovered, recovery.resume, state);
    return this.drained(state, call, lease, recovery);
  }

  /** The pass that takes the tree's recorded answers now; `undefined` when it has none (or rests no more). */
  private async nextPass(
    state: TreeState,
    call: TreeCall,
    passed?: ReadonlySet<string>,
  ): Promise<AnsweredPass | undefined> {
    const { deps, paused } = this.parts;
    const resume = await treeResumeNow(deps, state, passed);
    if (resume === undefined) return undefined;
    const stored = await paused.find(state);
    if (stored?.run.runId !== state.runId) return undefined;
    return { resume, pass: resumePassOf(stored, resume, call) };
  }

  private announce(
    reason: ResumeReason,
    resume: TreeResume | undefined,
    state: TreeState,
  ): Promise<void> {
    const event = executionEventAt(state, this.parts.deps.config);
    return announceResume(this.parts.deps.observer, event, reason, resume);
  }

  /**
   * Passes until the tree finishes or rests paused with no recorded answer left (the drain, Q58);
   * the pauses each pass took are marked `Taken` once it returned; the lease released at the end;
   * the record's pause answers read last.
   */
  private async drained(
    state: TreeState,
    call: TreeCall,
    lease: HeldExecutionLease,
    first: PlannedPass,
  ): Promise<ExecutionOutput> {
    const { deps } = this.parts;
    try {
      let planned: PlannedPass | undefined = first;
      let result: ExecutionOutput;
      const passed = new Set<string>();
      do {
        result = await this.observedPass(state, call, lease, planned.pass);
        if (planned.resume !== undefined) {
          await markTaken(deps, planned.resume);
          for (const pauseId of planned.resume.pauseIds) passed.add(pauseId);
        }
        const isPaused = result.status === ExecutionStatus.Paused;
        planned = isPaused ? await this.nextPass(state, call, passed) : undefined;
        if (planned !== undefined)
          await this.announce(ResumeReason.Answered, planned.resume, state);
      } while (planned !== undefined);
      if (result.status === ExecutionStatus.Finished) await this.forget(state);
      // who answered each pause (#267 S107): read once the pauses were taken and withdrawn
      return await withPauseAnswers(result, deps);
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
      return maskedRecordOf(runResultOf(run, call.record === true), deps.pii?.observability);
    });
  }

  /** The tree ended: its keys removed, its waiting pauses withdrawn (#267 AC10). */
  private async forget(state: TreeState): Promise<void> {
    await this.parts.trees.deleteAllInTree(treeOf(state));
    this.parts.deps.branchErrors?.forgetExecution(state.runId);
    const { pause } = this.parts.deps;
    if (pause !== undefined)
      await withdrawPauses(pause.pauses, treeOf(state), this.parts.clock.now());
  }
}

export const treeMovesOf = (parts: TreeMoveParts): TreeMoves => new TreeMover(parts);
