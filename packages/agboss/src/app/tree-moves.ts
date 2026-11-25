import { ResumeReason } from "../core/observability.js";
import { recordEndedOf, recoveryPassOf, RootCalls, takenPassOf } from "./recovery-pass.js";
import type {
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreeMoves,
  TreePass,
  TreeState,
} from "./tree-move-types.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import { currentOutputOf, refusedIfFailed } from "./current-output.js";
import { endedAtTakeOf } from "./take-end.js";
import { markedIfWithoutRecovery, treeOf } from "./tree-ends.js";
import type { RecordedAnswer } from "./resume.js";
import { announceResume, callWithLostPasses } from "./tree-resume.js";
import { expiredMove } from "./tree-expiry.js";
import { executionEventAt } from "./run-events.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { rootTakeOf, type HeldExecutionLease } from "./execution-leases.js";
import { startedOrSaid } from "./unstarted-run.js";
import { withTreeOrigin } from "./tree-origin.js";
import type { ExecutionOutput } from "./types.js";
import { isUnwinding } from "../flow/runtime/compensation/unwinding-marks.js";
import { unpausedMove } from "./unpause-move.js";
import { drainTree } from "./tree-drain.js";

/** Cancel requests (#360), loaded with the first pass. */
const cancelRequests = () => lazyLoad(import("./cancel-requests.js"));

/** Finishing an undo under way at a lease take (#340 PR 4), loaded only when one is found. */
const takeover = () => lazyLoad(import("./unwinding-takeover.js"));

/**
 * Moving an execution tree under its lease (#265, Q58; the concurrent resumes of #267): one pass
 * at a time per tree on any instance; before the holder lets the tree rest paused it takes the
 * decisions resolved meanwhile (the drain), so no recorded decision waits for another call. A
 * resume whose decision a holder took returns the tree's current output. Tree keys are removed
 * when the tree finishes or fails; a lost lease or an interruption leaves everything to the next
 * holder — recovery (#265 S30), which continues a `running` tree from its last checkpoint.
 */

export type * from "./tree-move-types.js";

class TreeMover implements TreeMoves {
  /** The roots a resume of this instance is moving or about to move: its own sweep leaves them. */
  readonly #resuming = new RootCalls();

  constructor(private readonly parts: TreeMoveParts) {}

  async first(state: TreeState, call: TreeCall, pass: TreePass): Promise<ExecutionOutput> {
    // #860: a run no recovery continues says so before its first pass, in its tree's keys
    await markedIfWithoutRecovery(call, this.parts.trees, treeOf(state));
    const lease = await this.parts.leases.hold(treeOf(state));
    return startedOrSaid(lease, this.drained(state, call, lease, { pass }));
  }

  async resumed(answer: RecordedAnswer, given: TreeCall): Promise<ExecutionOutput> {
    const { deps, paused, leases } = this.parts;
    const { pause, run } = answer;
    const state = await withTreeOrigin(deps, {
      runId: pause.rootExecutionId,
      threadId: pause.threadId,
      tenantId: pause.tenantId,
      startedVersion: run?.startedVersion ?? deps.config.version,
    });
    const leaving = this.#resuming.enter(state.runId);
    try {
      // answered: the tree has work again — the answer's own mark made its record `running` (#850);
      // a mark again, for a recovery that rested it meanwhile, is made under the lease, once the
      // answer is known to be there to take (`takenPassOf`): a write before the lease could land on
      // the rest a holder wrote after taking this very answer (#1179)
      const take = rootTakeOf(deps.pause, state.runId, LeaseTakeoverReason.Resumed);
      const lease = await leases.hold(treeOf(state), given.signal, take);
      // ended at the take: a cancelled tree resolves cancelled (#1341); one whose undo failed, or
      // that failed, rejects with its final error (#340 S7 1)
      const ended = await this.endedAtTake(state, lease);
      if (ended instanceof Error) throw ended;
      if (ended !== undefined) return ended;
      // the tree failed after the answer was recorded (#901): its holder's drain took the answer and
      // its pass stopped (a cancel request, gone with the tree's keys), the pause left `Resolved`
      // and the paused run of the rest before still stored — no pass moves an ended tree
      await refusedIfFailed(this.parts, state, { lease, pauseId: pause.pauseId });
      const call = await callWithLostPasses(this.parts, state, given);
      const next = await takenPassOf(this.parts, state, call).catch(async (error: unknown) => {
        await lease.release();
        throw error;
      });
      if (next === undefined) {
        await lease.release();
        return await currentOutputOf(deps, paused, state);
      }
      await this.announce(next.reason, next.planned.resume, state);
      return await this.drained(state, call, lease, next.planned);
    } finally {
      leaving();
    }
  }

  async recovered(
    interrupted: InterruptedRun,
    call: TreeCall,
  ): Promise<ExecutionOutput | undefined> {
    if (this.#isBusy(interrupted)) return undefined;
    const { runId, threadId, tenantId, startedVersion } = interrupted;
    const state = { runId, threadId, tenantId, startedVersion };
    const { Recovered } = LeaseTakeoverReason;
    const take = {
      ...rootTakeOf(this.parts.deps.pause, state.runId, Recovered, true),
      isOver: recordEndedOf(this.parts.deps.turns, interrupted.turnId),
    };
    const lease = await this.parts.leases.tryHold(treeOf(state), take);
    if (lease === undefined) return undefined;
    if ((await this.endedAtTake(state, lease)) !== undefined) return undefined;
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

  async unpaused(
    state: TreeState,
    call: TreeCall,
    command: { readonly ownerId?: string | undefined; readonly reason?: string | undefined },
  ): Promise<ExecutionOutput> {
    const leaving = this.#resuming.enter(state.runId);
    try {
      const hooks = {
        endedAtTake: (at: TreeState, lease: HeldExecutionLease) =>
          endedAtTakeOf(this.parts, at, lease, true),
        announce: async (
          reason: ResumeReason,
          resume: TreeResume | undefined,
          at: TreeState,
          unpauseReason?: string,
        ) => {
          if (reason !== ResumeReason.Unpaused) return this.announce(reason, resume, at);
          const event = executionEventAt(at, this.parts.deps);
          await this.parts.deps.observer.onExecutionResume({
            ...event,
            reason,
            decision: undefined,
            actor: undefined,
            ...(unpauseReason === undefined ? {} : { unpauseReason }),
          });
        },
        drained: (at: TreeState, held: HeldExecutionLease, planned: PlannedPass) =>
          this.drained(at, call, held, planned),
      };
      return await unpausedMove(this.parts, hooks, state, call, command);
    } finally {
      leaving();
    }
  }

  async endIfEnding(interrupted: InterruptedRun): Promise<boolean> {
    if (this.#isBusy(interrupted)) return false;
    if (await (await cancelRequests()).endIfCancelled(this.parts, interrupted)) return true;
    if (!(await isUnwinding(this.parts.trees, treeOf(interrupted)))) return false;
    return (await takeover()).endUnwindingIfFree(this.parts, interrupted);
  }

  async expired(interrupted: InterruptedRun, call: TreeCall, onTaken?: () => void): Promise<void> {
    if (this.#isBusy(interrupted)) return;
    const hooks = {
      endedAtTake: (state: TreeState, lease: HeldExecutionLease) => this.endedAtTake(state, lease),
      announce: (resume: TreeResume | undefined, state: TreeState) =>
        this.announce(ResumeReason.Expired, resume, state),
      drained: (state: TreeState, held: HeldExecutionLease, planned: PlannedPass) =>
        this.drained(state, call, held, planned),
    };
    await expiredMove(this.parts, hooks, interrupted, call, onTaken);
  }

  /**
   * A root a resume of this instance moves. Any other root's holder is read from the store: a
   * holder waiting for remote children keeps its lease there, yielded (#516), so the take fails.
   */
  #isBusy(interrupted: InterruptedRun): boolean {
    return this.#resuming.has(interrupted.runId);
  }

  /**
   * A lease just taken: a tree with a cancel request (#360) or an undo under way (#340 PR 4) is
   * ended without a pass and the lease released — its cancelled output, or its final error when it
   * failed; `undefined` otherwise.
   */
  private async endedAtTake(
    state: TreeState,
    lease: HeldExecutionLease,
  ): Promise<ExecutionOutput | Error | undefined> {
    return endedAtTakeOf(this.parts, state, lease);
  }

  announce(reason: ResumeReason, resume: TreeResume | undefined, state: TreeState): Promise<void> {
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
    const leaving = this.#resuming.enter(state.runId);
    return this.parts.live.moving(
      drainTree(this.parts, this, { state, call }, { lease, first }).finally(leaving),
    );
  }
}

export const treeMovesOf = (parts: TreeMoveParts): TreeMoves => new TreeMover(parts);
