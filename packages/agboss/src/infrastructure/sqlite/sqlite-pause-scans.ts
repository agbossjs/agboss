import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { PauseFilter, PausePage } from "../pause-notices.js";
import { PauseStatus, type PauseRecord } from "../pause-record.js";
import { pageOf, type SequencedPause } from "../pause-scans.js";
import { toPauseRecord } from "./sqlite-pause-rows.js";

/**
 * The scans of `SqlitePausedExecutionRepository` (#935, #910 rules 9, 10, 14): the deadline and
 * reminder scans on their indexes, the pages by `rowid` — SQLite's insertion sequence, the cursor's
 * text — and the retention's look and delete.
 */

const SequenceRow = z.object({ seq: z.number() });

/** What the retention removes: closed, resolved before the cutoff, with no live mailbox (I11). */
const REMOVABLE = `(p.status IN ('taken', 'cancelled') AND p.resolved_at IS NOT NULL AND p.resolved_at < ?
  AND NOT EXISTS (SELECT 1 FROM pause_notices n WHERE n.tenant_id = p.tenant_id
    AND n.pause_id = p.pause_id AND n.is_dead = 0 AND n.head_written_at IS NOT NULL))`;

/** A row with its insertion sequence, as the page reads it. */
const sequenced = (row: unknown): SequencedPause => ({
  pause: toPauseRecord(row),
  seq: SequenceRow.parse(row).seq,
});

export class SqlitePauseScans {
  constructor(private readonly database: DatabaseSync) {}

  /** `Pending` pauses with `column ≤ at`, by `(column, tenant, id)`, on the column's index. */
  pendingDue(column: "expires_at" | "remind_at", at: Date, limit: number): readonly PauseRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM pauses WHERE status = ? AND ${column} IS NOT NULL AND ${column} <= ?
           ORDER BY ${column}, tenant_id, pause_id LIMIT ?`,
      )
      .all(PauseStatus.Pending, at.toISOString(), limit)
      .map(toPauseRecord);
  }

  /** A page of the pauses `where` selects (a clause over alias `p`), after the cursor's sequence. */
  page(
    where: { readonly clause: string; readonly values: readonly SQLInputValue[] },
    from: number,
    limit: number,
  ): PausePage {
    const rows = this.database
      .prepare(
        `SELECT p.*, p.rowid AS seq FROM pauses p WHERE p.rowid > ? AND ${where.clause}
           ORDER BY p.rowid LIMIT ?`,
      )
      .all(from, ...where.values, limit + 1)
      .map(sequenced);
    return pageOf(rows, limit);
  }

  /** The open pauses (`Pending`, `Resolved`) after the cursor. */
  open(from: number, limit: number): PausePage {
    return this.page(
      { clause: "p.status IN (?, ?)", values: [PauseStatus.Pending, PauseStatus.Resolved] },
      from,
      limit,
    );
  }

  /** One tenant's pauses `filter` selects, after the cursor. */
  ofTenant(tenantId: string, filter: PauseFilter, from: number, limit: number): PausePage {
    const marks = filter.statuses.map(() => "?").join(", ");
    const clauses = [`p.tenant_id = ?`, `p.status IN (${marks})`];
    const values: SQLInputValue[] = [tenantId, ...filter.statuses];
    if (filter.channel !== undefined) {
      clauses.push("p.channel = ?");
      values.push(filter.channel);
    }
    if (filter.expiresBefore !== undefined) {
      clauses.push("p.expires_at IS NOT NULL AND p.expires_at < ?");
      values.push(filter.expiresBefore.toISOString());
    }
    return this.page({ clause: clauses.join(" AND "), values }, from, limit);
  }

  /** What `removeClosedBefore(cutoff)` removes, at most `limit`. */
  closedBefore(cutoff: Date, limit: number): readonly PauseRecord[] {
    return this.database
      .prepare(`SELECT p.* FROM pauses p WHERE ${REMOVABLE} ORDER BY p.rowid LIMIT ?`)
      .all(cutoff.toISOString(), limit)
      .map(toPauseRecord);
  }

  /** Removes what `closedBefore` lists, and their mailboxes (call inside a transaction). */
  removeClosedBefore(cutoff: Date): void {
    const at = cutoff.toISOString();
    this.database
      .prepare(
        `DELETE FROM pause_notices WHERE EXISTS (SELECT 1 FROM pauses p
           WHERE p.tenant_id = pause_notices.tenant_id AND p.pause_id = pause_notices.pause_id
             AND ${REMOVABLE})`,
      )
      .run(at);
    this.database.prepare(`DELETE FROM pauses AS p WHERE ${REMOVABLE}`).run(at);
  }
}
