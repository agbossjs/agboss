import { ResumeReason } from "../core/observability.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { InterruptedRun } from "../run/continue-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import { isHandedOver } from "./handed-over.js";
import { rootTakeOf, type HeldExecutionLease } from "./execution-leases.js";
import { treeOf, forgetTree } from "./tree-ends.js";
import { endOfRecord } from "./tree-end-pauses.js";
import type { ExecutionOutput } from "./types.js";
import { runningOutcome } from "../run/execute.js";
import { answeredPassOf, recoveryPassOf } from "./recovery-pass.js";
import { duePausesOf, expirePauses } from "./pause-expiry.js";
import type { PlannedPass, TreeCall, TreeMoveParts, TreeState } from "./tree-move-types.js";

/**
 * The part of moving a tree that an expiry adds (#941, I4, I6): the pass that takes the answers
 * recorded now, and the pass an expiry starts — the root marked `running` first (#850's order),
 * then the due pauses expired, then the pass that takes them. Nothing here takes the lease: the
 * caller holds it.
 */

/**
 * The pass an expiry starts for a tree its holder rests or is about to rest: `undefined` when no
 * pause is due (nothing is marked, nothing asked). `track.tried` — the pauses this holder already
 * tried to expire — keeps a store that refuses the expiry from looping a drain; `track.passed` —
 * what earlier passes of the drain took.
 */
export async function expiredPassOf(
  parts: TreeMoveParts,
  state: TreeState,
  call: TreeCall,
  track: { readonly tried: Set<string>; readonly passed?: ReadonlySet<string> },
): Promise<PlannedPass | undefined> {
  const { deps, paused, clock } = parts;
  const stored = await paused.find(state);
  if (stored?.run.runId !== state.runId) return undefined;
  const due = (await duePausesOf(parts, state, clock.now())).filter(
    (pause) => !track.tried.has(pause.pauseId),
  );
  if (due.length === 0) return undefined;
  // the tree has work again before its pause changes (#850): a death after the mark is recovery's
  const { run } = stored;
  const outcome = runningOutcome(run.path, run.cost.totalUsd);
  // (a mark another call made first leaves it `running` all the same)
  await deps.turns.completeIfStatus(run.turnId, ExecutionRecordStatus.Paused, outcome);
  for (const pause of due) track.tried.add(pause.pauseId);
  await expirePauses(parts, due, call.signal);
  const answered = await answeredPassOf(parts, state, call, track.passed);
  if (answered !== undefined) return answered;
  // nothing to take (the checkpoint moved on, a store refused): rest the tree again, as recovery does
  const interrupted = { ...state, turnId: run.turnId };
  return recoveryPassOf(parts, interrupted, call);
}

/** The status of a root that rests (a record's status is text: it may be compared with this). */
const RESTING: string = ExecutionRecordStatus.Paused;

/**
 * Whether the root's record says the tree rests paused: a `running` one is moving, or its recovery's
 * to continue (its drain expires the pause before it rests, I6); an ended one is finished here — its
 * tree's end, the orphan look's (#939).
 */
async function isResting(parts: TreeMoveParts, state: TreeState, turnId: string): Promise<boolean> {
  const [record] = await parts.deps.turns.byIds([turnId]);
  if (record === undefined) return false;
  const status: string = record.status;
  if (status === RESTING) return true;
  if (ENDED.includes(status)) await forgetTree(parts, state, endOfRecord(record));
  return false;
}

/** The statuses of a root that ended (text: a record's status may be compared with them). */
const ENDED: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
];

/**
 * Whether a drain that rejected ended the run (#1074): its record is `answered`, `failed` or
 * `guarded` — the run's own outcome (a run deadline reached, an uncaught `fail()` of the expiry),
 * recorded and observed (`onExecutionError`) by the pass itself, not a failure of the expiry. A
 * record that is not read, or still moving, leaves the rejection what it is: the machinery's.
 */
export async function endedByRun(
  parts: Pick<TreeMoveParts, "deps">,
  turnId: string,
): Promise<boolean> {
  // a record that is not read is no end of the run: the read's failure is answered here, never in the check below
  const record = await parts.deps.turns.byIds([turnId]).then(
    ([found]) => found,
    () => undefined,
  );
  return record !== undefined && ENDED.includes(record.status);
}

/** The drain of the pass an expiry started; a run that ended or was handed over is its outcome, not a failure. */
async function drainedAfterExpiry(
  parts: TreeMoveParts,
  hooks: ExpiryHooks,
  drain: { state: TreeState; lease: HeldExecutionLease; planned: PlannedPass },
  turnId: string,
): Promise<void> {
  try {
    await hooks.drained(drain.state, drain.lease, drain.planned);
  } catch (error) {
    // the run failed or was handed over after its expiry: its outcome, not the expiry's failure
    if (isHandedOver(error) || (await endedByRun(parts, turnId))) return;
    throw error;
  }
}

/** What an expiry move needs of the mover that holds the tree (`tree-moves.ts`). */
export interface ExpiryHooks {
  /** A cancel request or an undo under way ends the tree at the take: its error, the lease released. */
  readonly endedAtTake: (state: TreeState, lease: HeldExecutionLease) => Promise<Error | undefined>;
  /** `onExecutionResume(Expired)` for the pass the expiry starts. */
  readonly announce: (resume: TreeResume | undefined, state: TreeState) => Promise<void>;
  /** The drain under the held lease: it releases the lease. */
  readonly drained: (
    state: TreeState,
    lease: HeldExecutionLease,
    first: PlannedPass,
  ) => Promise<ExecutionOutput>;
}

/**
 * The expiry look's move (`TreeMoves.expired`): the tree's lease when free — else its holder's drain,
 * or a later look, does it (I5, I6) —, then what ends a tree at any take (a cancel request: a cancel
 * beats an expiry), then only a tree that rests with a pause due: the root marked `running`, the
 * pauses expired, the pass that takes them, drained under the same lease.
 */
export async function expiredMove(
  parts: TreeMoveParts,
  hooks: ExpiryHooks,
  interrupted: InterruptedRun,
  call: TreeCall,
  onTaken?: () => void,
): Promise<void> {
  const { runId, threadId, tenantId, startedVersion } = interrupted;
  const state = { runId, threadId, tenantId, startedVersion };
  const take = rootTakeOf(parts.deps.pause, runId, LeaseTakeoverReason.Expired);
  const lease = await parts.leases.tryHold(treeOf(state), take);
  if (lease === undefined) return;
  try {
    if ((await hooks.endedAtTake(state, lease)) !== undefined) return;
    const resting = await isResting(parts, state, interrupted.turnId);
    // a resting tree is this instance's to move: from here the expiry is real work — the channel's
    // handler, and the pass after it — and counts against the cap (#1092); the look waits only
    // for this decision, never for the work
    if (resting) onTaken?.();
    const planned = resting
      ? await expiredPassOf(parts, state, call, { tried: new Set() })
      : undefined;
    if (planned === undefined) {
      await lease.release();
      return;
    }
    await hooks.announce(planned.resume, state);
    await drainedAfterExpiry(parts, hooks, { state, lease, planned }, interrupted.turnId);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/**
 * What a drain continues with at a rest: the answers recorded meanwhile (`Answered`), else the due
 * pauses' expiry (`Expired`) — a pass never rests on a due pause (I6); `undefined` when neither.
 */
export async function restedPassOf(
  parts: TreeMoveParts,
  state: TreeState,
  call: TreeCall,
  track: { readonly passed: ReadonlySet<string>; readonly tried: Set<string> },
): Promise<{ readonly planned: PlannedPass; readonly reason: ResumeReason } | undefined> {
  // the drain's own rest went before it: the record marked running again (#1187)
  const answered = await answeredPassOf(parts, state, call, track.passed, true);
  if (answered !== undefined) return { planned: answered, reason: ResumeReason.Answered };
  const expired = await expiredPassOf(parts, state, call, track);
  return expired === undefined ? undefined : { planned: expired, reason: ResumeReason.Expired };
}
