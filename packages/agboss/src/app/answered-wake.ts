import { isExternallyPaused } from "./external-pause.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "../infrastructure/execution-record.repository.js";
import type { Turn } from "../turns/index.js";
import { rootTakeOf } from "./execution-leases.js";
import { runningOutcome } from "../run/execute.js";
import { treeResumeNow, type TreeRun } from "./tree-resume.js";
import type { TreeState } from "./tree-move-types.js";
import type { AppDeps } from "./app-deps.js";
import { PauseStatus } from "../infrastructure/pause-record.js";
import { StatusTrigger, ThreadStatus } from "../turns/index.js";
import { treeOf } from "./tree-ends.js";
import type { TreeMoveParts } from "./tree-move-types.js";

/**
 * A `paused` root beside an answer no pass took (#1187): its holder's drain rested (its pass wrote
 * `paused`) and died before it marked the record `running` again to take an answer recorded
 * meanwhile, and the resume that recorded it is gone too. No `running` record, so no recovery; no
 * pending pause, so no resume. The sweep's look at the open pauses finds it: under the tree's lease —
 * nothing moves the tree while it is held, a holder's rest and a late mark included (#1179) — it
 * checks that a waiting interrupt still has its answer recorded and untaken (`treeResumeNow`: a
 * `Resolved` pause of a withdrawn branch beside a pending one is no answer to take, and never wakes
 * the tree) and marks the record `running` from the record itself (a compare-and-set from `paused`) — a holder that died between its
 * rest and keeping its paused run leaves none to read — the work recovery continues in the same
 * sweep (under its own take of the lease: the answer taken once). `true` when it marked it; `false`
 * when the lease is held (its holder takes the answer), the record is not `paused`, or nothing is
 * left to take.
 */
export type WakeAnswered = (record: Turn) => Promise<boolean>;

/** The status of a root that rests (a record's status is text: it may be compared with this). */
const RESTING: string = ExecutionRecordStatus.Paused;

export const wakeAnsweredOf =
  (parts: Pick<TreeMoveParts, "deps" | "leases">): WakeAnswered =>
  async (record) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null || record.status !== RESTING) return false;
    const { deps, leases } = parts;
    const startedVersion = record.configVersion ?? deps.config.version;
    const state = { runId, threadId, tenantId, startedVersion };
    const take = {
      ...rootTakeOf(deps.pause, runId, LeaseTakeoverReason.Recovered, true),
      isOver: async (): Promise<boolean> =>
        (await deps.turns.byIds([record.id]))[0]?.status !== RESTING,
    };
    const lease = await leases.tryHold(treeOf(state), take);
    if (lease === undefined) return false;
    try {
      // frozen from outside (#1341c): an answered pause does not wake it before `app.unpause`
      if (await isExternallyPaused(leases, treeOf(state))) return false;
      if ((await treeResumeNow(deps, state)) === undefined) return false;
      // a compare-and-set from `paused`: a record a holder moved meanwhile is not marked
      const outcome = runningOutcome(record.route, record.costUsd);
      return await deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, outcome);
    } finally {
      await lease.release();
    }
  };

/**
 * A tree parked by `app.pause` (#1341c) whose freeze was lifted but whose record is still `paused`: an
 * `app.unpause` died between the two writes (the mark cleared, the record not yet `running`), and no
 * pending pause, no answer and no `running` record say that the tree has work. Under the tree's
 * lease — a holder moves it, never raced — it is a parked orphan when its record is `paused`, its
 * lease row carries no pause and no pause of the tree is pending or resolved (a business rest is the pauses'
 * own, woken by `wakeAnswered` or an expiry): the record is marked `running` from itself (a
 * compare-and-set from `paused`, the history row `Unpause`), the work recovery continues in the same
 * sweep from the tree's checkpoint. `true` when it marked it; `false` when the lease is held, the tree
 * is frozen (it waits for `app.unpause`), rests at a business pause, or the record moved meanwhile.
 */
export type WakeParked = (record: Turn) => Promise<boolean>;

/**
 * Whether a pause of the tree still waits for its decision or for a pass to take it: a business rest,
 * not a parked tree. Read from the tree's pauses, never from its paused-run row: a pass that `app.pause`
 * parked after a resume leaves the row of the earlier rest in place, stale under the same run id.
 */
export async function isAtBusinessPause(deps: AppDeps, tree: TreeRun): Promise<boolean> {
  const records = await deps.pause?.pauses.findAllByTenantIdAndRootExecutionId(
    tree.tenantId,
    tree.runId,
  );
  return (records ?? []).some(
    (pause) => pause.status === PauseStatus.Pending || pause.status === PauseStatus.Resolved,
  );
}

/** Whether the thread's last status change is an operator's pause or the lift of one (#1341d). */
async function isUnpausing(
  records: Pick<ExecutionRecordRepository, "statusHistory">,
  tree: TreeState,
): Promise<boolean> {
  const last = (await records.statusHistory(tree.tenantId, tree.threadId)).at(-1);
  return (
    last?.toStatus === ThreadStatus.ExternallyPaused || last?.trigger === StatusTrigger.Unpause
  );
}

export const wakeParkedOf =
  (
    parts: Pick<TreeMoveParts, "deps" | "leases">,
    records: Pick<ExecutionRecordRepository, "statusHistory">,
  ): WakeParked =>
  async (record) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null || record.status !== RESTING) return false;
    const { deps, leases } = parts;
    const startedVersion = record.configVersion ?? deps.config.version;
    const state = { runId, threadId, tenantId, startedVersion };
    // read only, before any lease is taken: a frozen tree and a business rest — most of the `paused`
    // roots the look pages through — cost no write
    if (await isExternallyPaused(leases, treeOf(state))) return false;
    if (await isAtBusinessPause(deps, state)) return false;
    // only a tree the history says an operator parked and began to unpause: a `paused` record with no
    // pause rows is no proof (a restarted application with in-memory pauses has none of anyone's)
    if (!(await isUnpausing(records, state))) return false;
    const take = {
      ...rootTakeOf(deps.pause, runId, LeaseTakeoverReason.Recovered, true),
      isOver: async (): Promise<boolean> =>
        (await deps.turns.byIds([record.id]))[0]?.status !== RESTING,
    };
    const lease = await leases.tryHold(treeOf(state), take);
    if (lease === undefined) return false;
    try {
      // the lease is the one place the mark is written under: asked again now that it is held
      if (await isExternallyPaused(leases, treeOf(state))) return false;
      const outcome = runningOutcome(record.route, record.costUsd);
      return await deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, outcome, {
        toStatus: ThreadStatus.Running,
        trigger: StatusTrigger.Unpause,
      });
    } finally {
      await lease.release();
    }
  };
