import type { PauseReassignmentChange, PauseRecipients } from "../pause-notices.js";
import { reassignChange } from "../pause-reassign-transition.js";
import type { PauseRecord } from "../pause-record.js";
import type { SqliteConnection } from "./sqlite-connection.js";
import { oneRowChanged } from "./sqlite-connection.js";
import type { SqlitePauseNoticeRows } from "./sqlite-pause-notice-rows.js";
import type { SqlitePauseRows } from "./sqlite-pause-row-statements.js";

/** What a reassignment's transaction reads and writes (#946). */
export interface ReassignRows {
  readonly connection: SqliteConnection;
  readonly pauses: SqlitePauseRows;
  readonly notices: SqlitePauseNoticeRows;
}

/** The pause a reassignment moves, and what it moves to. */
export interface ReassignTarget {
  readonly tenantId: string;
  readonly pauseId: string;
  readonly replacement: PauseReassignmentChange;
}

/**
 * One `BEGIN IMMEDIATE` transaction: the pause read, the next free `~r<n>` of its step's key among the
 * tree's, the change planned by `reassignChange`, the old pause written over the status it was read
 * at, its notices appended and the replacement inserted — all or nothing. The replacement, or
 * `undefined` when the pause is not open at `at`.
 */
export function reassignedIn(
  rows: ReassignRows,
  target: ReassignTarget,
  at: Date,
  recipients: PauseRecipients,
): PauseRecord | undefined {
  const { tenantId, pauseId, replacement } = target;
  return rows.connection.transaction((): PauseRecord | undefined => {
    const current = rows.pauses.findById(tenantId, pauseId);
    if (current === undefined) return undefined;
    const taken = new Set(
      rows.pauses.findAllByRoot(tenantId, current.rootExecutionId).map((pause) => pause.stepKey),
    );
    const change = reassignChange(current, replacement, taken, at, recipients);
    if (change === undefined) return undefined;
    oneRowChanged(rows.pauses.write(change.pause, current.status) ? 1 : 0);
    rows.notices.append(change.pause, change.notices);
    // in place: the changed pause itself; otherwise the replacement is inserted
    if (change.inserted === undefined) return change.pause;
    rows.pauses.insert(change.inserted);
    return change.inserted;
  });
}
