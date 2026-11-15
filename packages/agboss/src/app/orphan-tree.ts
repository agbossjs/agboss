import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import type { Turn } from "../turns/index.js";
import { rootTakeOf } from "./execution-leases.js";
import { endOfRecord } from "./tree-end-pauses.js";
import { forgetTree, treeOf, type TreeEndParts } from "./tree-ends.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { CancelParts } from "./cancel-requests.js";
import { wakeAnsweredOf, type WakeAnswered } from "./answered-wake.js";

/**
 * Finishing the end of a tree whose instance died in the middle of it (#939, #910 I13): under the
 * tree's lease — a live holder ends its own tree, never raced — the whole idempotent `forgetTree`
 * (its keys, its queued children, its branch errors, its pauses), on the cause its root's ended
 * record gives. `false` when the lease is held elsewhere (left to a later look); `true` when done.
 */
export type CloseOrphanTree = (record: Turn) => Promise<boolean>;

/** The status of a root that rests (a record's status is text: it may be compared with this). */
const PAUSED: string = ExecutionRecordStatus.Paused;

/** What a workflow's app needs to finish a tree's end. */
export type OrphanTreeParts = TreeEndParts & CancelParts;

const closeOrphanTreeOf =
  (parts: OrphanTreeParts): CloseOrphanTree =>
  async (record) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null) return false;
    const startedVersion = record.configVersion ?? parts.deps.config.version;
    const state = { runId, threadId, tenantId, startedVersion };
    // a tree resting with a cancel nobody finished (#1152): ended as `app.cancel` ends it
    if (record.status === PAUSED) {
      // loaded on the first resting root, as the cancel code is on a first cancel
      const { endRestingCancelled } = await lazyLoad(import("./cancel-resting.js"));
      return await endRestingCancelled(parts, { ...state, turnId: record.id });
    }
    const take = rootTakeOf(parts.deps.pause, runId, LeaseTakeoverReason.Recovered);
    const lease = await parts.leases.tryHold(treeOf(state), take);
    if (lease === undefined) return false;
    try {
      await forgetTree(parts, state, endOfRecord(record));
      return true;
    } finally {
      await lease.release();
    }
  };

/** What the sweep's look at a workflow's open pauses does with its trees (#939, #1152, #1187). */
export interface OrphanEnds {
  /** Finishes the end of one of its trees an instance died in (the orphan look, #939). */
  readonly closeOrphan: CloseOrphanTree;
  /** Marks `running` one of its `paused` roots beside an untaken answer (the same look, #1187). */
  readonly wakeAnswered: WakeAnswered;
}

export const orphanEndsOf = (parts: OrphanTreeParts): OrphanEnds => ({
  closeOrphan: closeOrphanTreeOf(parts),
  wakeAnswered: wakeAnsweredOf(parts),
});
