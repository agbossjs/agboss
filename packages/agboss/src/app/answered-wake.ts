import { isExternallyPaused } from "./external-pause.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { Turn } from "../turns/index.js";
import { rootTakeOf } from "./execution-leases.js";
import { runningOutcome } from "../run/execute.js";
import { treeResumeNow } from "./tree-resume.js";
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
