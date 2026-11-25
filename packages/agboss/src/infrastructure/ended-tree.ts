import type { Clock } from "./clock.js";
import type { EndedTree, ExecutionAuditLogRepository } from "./execution-audit-log.repository.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import { hours, type Milliseconds } from "../units/index.js";

/** The statuses of a root record that ended (text: a record's status may be compared with them). */
const ENDED_STATUSES: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
  ExecutionRecordStatus.Stopped,
  ExecutionRecordStatus.Cancelled,
];

/**
 * Whether a tree ended, by its root's record. A tree with no record, a `running` or a `paused` one
 * counts as live: nothing is removed on a guess.
 */
export const endedTreeOf =
  (records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">): EndedTree =>
  async ({ tenantId, rootExecutionId }) => {
    const record = await records.findByTenantIdAndRunId(tenantId, rootExecutionId);
    return record !== undefined && ENDED_STATUSES.includes(record.status);
  };

/**
 * How long a tree's newest audit row must be old before a tree with no record at all counts as
 * swept: a record is written before any row, so a missing one this long after the last row means the
 * idle-thread sweep removed it (a crash or a failing audit store between its two steps left the rows
 * behind, #1410 M2), not that a record is still racing to be written.
 */
const MISSING_RECORD_GRACE: Milliseconds = hours(24);

/**
 * Whether an audit log's tree may lose its rows: its root's record ended, or the record is gone and
 * every row of the tree is older than the cutoff and the grace. A tree with a `running` or `paused`
 * record, or with no record and a recent row, counts as live: nothing is removed on a guess.
 */
export const endedOrSweptTreeOf =
  (
    records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">,
    auditLog: ExecutionAuditLogRepository,
    clock: Clock,
    cutoff: Date,
  ): EndedTree =>
  async (tree) => {
    const record = await records.findByTenantIdAndRunId(tree.tenantId, tree.rootExecutionId);
    if (record !== undefined) return ENDED_STATUSES.includes(record.status);
    const newestAllowed = Math.min(cutoff.getTime(), clock.now().getTime() - MISSING_RECORD_GRACE);
    const rows = await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      tree.tenantId,
      tree.rootExecutionId,
    );
    return rows.every((row) => Date.parse(row.occurredAt) < newestAllowed);
  };
