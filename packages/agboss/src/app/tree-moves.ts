import { ResumeReason } from "../core/observability.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { recoveryPassOf, resumePassOf, RootCalls } from "./recovery-pass.js";
import type {
  AnsweredPass,
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreeMoves,
  TreePass,
  TreeState,
} from "./tree-move-types.js";
import { runningOutcome } from "../run/execute.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import { currentOutputOf } from "./current-output.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { isHandedOver } from "./handed-over.js";
import { cancelledErrorOf } from "./live-runs.js";
import { forgetTree, passEnded, treeOf } from "./tree-ends.js";
import { observedPass } from "./observed-pass.js";
import type { RecordedAnswer } from "./resume.js";
import { announceResume, markTaken, treeResumeNow } from "./tree-resume.js";
import { withPauseAnswers } from "./result.js";
import { executionEventAt } from "./run-events.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import type * as CancelRequests from "./cancel-requests.js";

/** Cancel requests (#360), loaded with the first pass. */
const cancelRequests = (): Promise<typeof CancelRequests> => import("./cancel-requests.js");

/**
 * Moving an execution tree under its lease (#265, Q58; the concurrent resumes of #267): one pass
 * at a time per tree on any instance; before the holder lets the tree rest paused it takes the
 * decisions resolved meanwhile (the drain), so no recorded decision waits for another call. A
 * resume whose decision a holder took returns the tree's current output. Tree keys are removed
 * when the tree finishes or fails; a lost lease or an interruption leaves everything to the next
 * holder — recovery (#265 S30), which continues a `running` tree from its last checkpoint.
 */

export type {
  AnsweredPass,
  HeldPass,
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreeMoves,
  TreePass,
  TreeState,
} from "./tree-move-types.js";

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
      if (await (await cancelRequests()).endedAtTake(this.parts, state, lease))
        throw cancelledErrorOf(state.threadId);
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
    if (
      lease === undefined ||
      (await (await cancelRequests()).endedAtTake(this.parts, state, lease))
    )
      return undefined;
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

  async endIfCancelled(interrupted: InterruptedRun): Promise<boolean> {
    if (this.#resuming.has(interrupted.runId)) return false;
    return (await cancelRequests()).endIfCancelled(this.parts, interrupted);
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
    const event = executionEventAt(state, this.parts.deps);
    return announceResume(this.parts.deps.observer, event, reason, resume);
  }

  /** The drain, in flight until its lease is released (what the graceful stop awaits, #367). */
  private drained(
    state: TreeState,
    call: TreeCall,
    lease: HeldExecutionLease,
    first: PlannedPass,
  ): Promise<ExecutionOutput> {
    return this.parts.live.moving(this.drain(state, call, lease, first));
  }

  /**
   * Passes until the tree finishes or rests paused with no recorded answer left (the drain, Q58);
   * the pauses each pass took are marked `Taken` once it returned; the lease released at the end —
   * while the instance stops, only after the tree's running step bodies returned (#367); the
   * record's pause answers read last.
   */
  private async drain(
    state: TreeState,
    call: TreeCall,
    lease: HeldExecutionLease,
    first: PlannedPass,
  ): Promise<ExecutionOutput> {
    const { deps, live } = this.parts;
    try {
      // a cancel requested on another instance stops the passes at a renewal (#360)
      const watch = (await cancelRequests()).cancelWatchOf(this.parts.trees, state);
      lease.afterEachRenewal(watch.check);
      let planned: PlannedPass | undefined = first;
      let result: ExecutionOutput;
      const passed = new Set<string>();
      do {
        result = await observedPass(this.parts, state, call, { lease, watch }, planned.pass);
        if (planned.resume !== undefined) {
          await markTaken(deps, planned.resume);
          for (const pauseId of planned.resume.pauseIds) passed.add(pauseId);
        }
        await (
          await cancelRequests()
        ).endIfCancelledAtRest(this.parts, state, { result, watch, lease });
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
      await passEnded(live, deps, state);
      await lease.release();
    }
  }

  /** The tree ended: its keys removed, its waiting pauses withdrawn (#267 AC10). */
  private forget(state: TreeState): Promise<void> {
    return forgetTree(this.parts, state);
  }
}

export const treeMovesOf = (parts: TreeMoveParts): TreeMoves => new TreeMover(parts);
