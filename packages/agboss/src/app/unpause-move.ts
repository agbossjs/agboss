import { PauseError } from "../core/error-families/pause-errors.js";
import { ExecutionError } from "../core/error-families/run-errors.js";
import { continueAgent } from "../run/continue-agent.js";
import { runningOutcome } from "../run/execute.js";
import { StatusTrigger, ThreadStatus, type NewStatusTransition } from "../turns/index.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { isAtBusinessPause } from "./answered-wake.js";
import { currentOutputOf } from "./current-output.js";
import { rootRecordOf } from "./ended-tree.js";
import { rootTakeOf, type HeldExecutionLease } from "./execution-leases.js";
import { runOptionsOf } from "./live-runs.js";
import { treeOf } from "./tree-ends.js";
import { restedPassOf } from "./tree-expiry.js";
import type { PlannedPass, TreeCall, TreeMoveParts, TreeState } from "./tree-move-types.js";
import type { ExecutionOutput } from "./types.js";
import { ResumeReason } from "../core/observability.js";
import type { TreeResume } from "../run/resume-map.js";

/**
 * The move of `app.unpause` (#1341c): the tree's lease first — a holder that is still parking (the
 * pause is `Pausing`) finishes its park and gives it up, so the mark is cleared only by the one who
 * holds the tree and a pass never parks over a lift — then, under it, what ends a tree at any take (a
 * cancel or stop request beats an unpause), then the lift. A tree parked at a step boundary
 * continues from its checkpoint (`ResumeReason.Unpaused`); one that rests at a business pause
 * (`dual_paused`) only has the operator's freeze lifted, and takes what waited for it — an answer a
 * channel decided, a deadline that passed — through the rest's own passes. The order is the safe
 * one: the record goes `running` first, the mark is cleared next; a crash between leaves a `running`
 * record with the mark still set, which recovery's take reads as frozen and parks again — never a
 * tree running with the freeze half lifted.
 */

/** What the move needs of the mover that holds the tree (`tree-moves.ts`). */
export interface UnpauseHooks {
  /** A cancel or stop request or an undo under way ends the tree at the take (the lease released). */
  readonly endedAtTake: (
    state: TreeState,
    lease: HeldExecutionLease,
  ) => Promise<ExecutionOutput | Error | undefined>;
  /** `onExecutionResume`, with the operator's reason when `reason` is `Unpaused`. */
  readonly announce: (
    reason: ResumeReason,
    resume: TreeResume | undefined,
    state: TreeState,
    unpauseReason?: string,
  ) => Promise<void>;
  /** The drain under the held lease: it releases the lease. */
  readonly drained: (
    state: TreeState,
    lease: HeldExecutionLease,
    first: PlannedPass,
  ) => Promise<ExecutionOutput>;
}

/** Who lifts the pause and why. */
export interface UnpauseCommand {
  readonly ownerId?: string | undefined;
  readonly reason?: string | undefined;
}

const ENDED: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
  ExecutionRecordStatus.Stopped,
  ExecutionRecordStatus.Cancelled,
];

/** The history row of the lift (#1341d): the thread is `Running` again, or `Paused` at its business pause. */
const liftOf = (
  state: TreeState,
  toStatus: ThreadStatus,
  command: UnpauseCommand,
): NewStatusTransition => ({
  tenantId: state.tenantId,
  threadId: state.threadId,
  toStatus,
  trigger: StatusTrigger.Unpause,
  ...(command.ownerId === undefined ? {} : { actor: command.ownerId }),
  ...(command.reason === undefined ? {} : { reason: command.reason }),
});

/** Lifts the freeze of `state`'s tree; its output (a continued pass's, or the rest it stays at). */
export async function unpausedMove(
  parts: TreeMoveParts,
  hooks: UnpauseHooks,
  state: TreeState,
  call: TreeCall,
  command: UnpauseCommand,
): Promise<ExecutionOutput> {
  const { deps, leases } = parts;
  const tree = treeOf(state);
  const lease = await leases.hold(
    tree,
    call.signal,
    rootTakeOf(deps.pause, state.runId, LeaseTakeoverReason.Resumed),
  );
  try {
    const ended = await hooks.endedAtTake(state, lease);
    if (ended instanceof Error) throw ended;
    if (ended !== undefined) return ended;
    const record = await rootRecordOf(deps, state);
    if (record === undefined || ENDED.includes(record.status)) {
      throw new ExecutionError.AlreadyTerminal({
        message: `thread "${state.threadId}" has ended: it cannot be unpaused`,
      });
    }
    // another unpause lifted it while this one waited for the lease
    if ((await leases.pauseOf(tree)).pause === undefined) {
      throw new PauseError.NotPaused({
        message: `thread "${state.threadId}" is not paused from outside`,
      });
    }
    // from the tree's open pauses: a park after a resume leaves the earlier rest's paused run behind
    if (await isAtBusinessPause(deps, state))
      return await liftedAtRest(parts, hooks, { state, call, command, lease });
    // parked at a step boundary, or left `running` by a holder that died before it parked
    if (record.status === "paused") {
      const outcome = runningOutcome(record.route, record.costUsd);
      const context = liftOf(state, ThreadStatus.Running, command);
      await deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, outcome, context);
    }
    await leases.unpause(tree, liftOf(state, ThreadStatus.Running, command));
    await hooks.announce(ResumeReason.Unpaused, undefined, state, command.reason);
    const interrupted = { ...state, turnId: record.id };
    const pass: PlannedPass = {
      pass: (moving, signal) => continueAgent(interrupted, moving, runOptionsOf(call, signal)),
    };
    return await hooks.drained(state, lease, pass);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/**
 * A tree frozen while it rests at a business pause: the freeze is lifted, the rest keeps what it
 * waits for. An answer recorded and not taken, or a deadline that passed meanwhile, has its pass now
 * (the rest's own: `restedPassOf`); otherwise the tree stays paused and its output says so.
 */
async function liftedAtRest(
  parts: TreeMoveParts,
  hooks: UnpauseHooks,
  at: {
    readonly state: TreeState;
    readonly call: TreeCall;
    readonly command: UnpauseCommand;
    readonly lease: HeldExecutionLease;
  },
): Promise<ExecutionOutput> {
  const { state, call, command, lease } = at;
  const { deps, leases, paused } = parts;
  await leases.unpause(treeOf(state), liftOf(state, ThreadStatus.Paused, command));
  const next = await restedPassOf(parts, state, call, { passed: new Set(), tried: new Set() });
  if (next === undefined) {
    await lease.release();
    return currentOutputOf(deps, paused, state);
  }
  await hooks.announce(next.reason, next.planned.resume, state);
  return hooks.drained(state, lease, next.planned);
}
