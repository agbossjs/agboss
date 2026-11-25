import type { DatabaseSync } from "node:sqlite";
import { ChildPlacement } from "../../flow/child-placement.js";
import type { QueuedChildExecution } from "../child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../execution-record.repository.js";
import { childOf } from "./sqlite-child-queue-rows.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/** The queued `IsolatedWorker` rows and their targeted claim (#1286b), on the child queue's table. */

/** The `Queued` `IsolatedWorker` children, the deepest first, then the longest waiting. */
export function queuedIsolatedOf(
  database: DatabaseSync,
  limit: number,
): readonly QueuedChildExecution[] {
  const rows = database
    .prepare(
      `SELECT * FROM child_execution_queue WHERE status = ? AND placement = ?
       ORDER BY depth DESC, queued_at LIMIT ?`,
    )
    .all(ExecutionRecordStatus.Queued, ChildPlacement.IsolatedWorker, limit);
  return rows.map(childOf);
}

/** Who claims which child, and when. */
export interface IsolatedClaim {
  readonly tenantId: string;
  readonly executionId: string;
  readonly instanceId: string;
  readonly at: number;
}

/** Claims the child for the instance when it is `Queued` and `IsolatedWorker`; call it in a transaction. */
export function isolatedClaimOf(
  connection: SqliteConnection,
  claim: IsolatedClaim,
): QueuedChildExecution | undefined {
  const { database } = connection;
  const { tenantId, executionId } = claim;
  const { changes } = database
    .prepare(
      `UPDATE child_execution_queue SET status = ?, instance_id = ?, claimed_at = ?
       WHERE tenant_id = ? AND execution_id = ? AND status = ? AND placement = ?`,
    )
    .run(
      ExecutionRecordStatus.Running,
      claim.instanceId,
      claim.at,
      tenantId,
      executionId,
      ExecutionRecordStatus.Queued,
      ChildPlacement.IsolatedWorker,
    );
  if (Number(changes) !== 1) return undefined;
  const row = database
    .prepare("SELECT * FROM child_execution_queue WHERE tenant_id = ? AND execution_id = ?")
    .get(tenantId, executionId);
  return row === undefined ? undefined : childOf(row);
}
