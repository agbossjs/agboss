import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import type { Turn } from "../turns/index.js";
import { rootTakeOf } from "./execution-leases.js";
import { endOfRecord } from "./tree-end-pauses.js";
import { forgetTree, treeOf, type TreeEndParts } from "./tree-ends.js";
import { endRestingCancelled, RESTING } from "./cancel-resting.js";
import type { CancelParts } from "./cancel-requests.js";

/**
 * Finishing the end of a tree whose instance died in the middle of it (#939, #910 I13): under the
 * tree's lease — a live holder ends its own tree, never raced — the whole idempotent `forgetTree`
 * (its keys, its queued children, its branch errors, its pauses), on the cause its root's ended
 * record gives. `false` when the lease is held elsewhere (left to a later look); `true` when done.
 */
export type CloseOrphanTree = (record: Turn) => Promise<boolean>;

/** What a workflow's app needs to finish a tree's end. */
export type OrphanTreeParts = TreeEndParts & CancelParts;

export const closeOrphanTreeOf =
  (parts: OrphanTreeParts): CloseOrphanTree =>
  async (record) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null) return false;
    const startedVersion = record.configVersion ?? parts.deps.config.version;
    const state = { runId, threadId, tenantId, startedVersion };
    // a tree resting with a cancel nobody finished (#1152): ended as `app.cancel` ends it
    if (record.status === RESTING)
      return await endRestingCancelled(parts, { ...state, turnId: record.id });
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
