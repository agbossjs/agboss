import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { toMailbox } from "./sqlite-pause-notice-schema.js";
import {
  acknowledgedMailbox,
  appendedMailbox,
  claimedMailbox,
  hasNoticeOf,
  isHeldBy,
  isLive,
  mailboxOf,
  retriedMailbox,
  setAsideMailbox,
  type PlannedNotice,
  type StoredMailbox,
} from "../pause-mailboxes.js";
import {
  type PauseNoticeKind,
  type PauseNoticeClaim,
  type PauseNoticeCounts,
  type SetAsideMailbox,
} from "../pause-notices.js";
import type { PauseRecord } from "../pause-record.js";

/**
 * The mailboxes of `SqlitePausedExecutionRepository` (#935): one row per (tenant, pause, recipient)
 * holding its notices in order, a delivered count, the attempts, `next_attempt_at`, the head's
 * `head_written_at`, the claim and `is_dead`. Every method is one step of a transaction its caller
 * opened: the row is read, changed by the pure rules of `pause-mailboxes.ts` and written back.
 */

/** The statements of the mailboxes, on one connection's database. */
export class SqlitePauseNoticeRows {
  constructor(private readonly database: DatabaseSync) {}

  find(tenantId: string, pauseId: string, recipient: string): StoredMailbox | undefined {
    const row = this.database
      .prepare("SELECT * FROM pause_notices WHERE tenant_id = ? AND pause_id = ? AND recipient = ?")
      .get(tenantId, pauseId, recipient);
    return row === undefined ? undefined : toMailbox(row);
  }

  /** Every mailbox of the pause. */
  ofPause(tenantId: string, pauseId: string): readonly StoredMailbox[] {
    return this.database
      .prepare("SELECT * FROM pause_notices WHERE tenant_id = ? AND pause_id = ?")
      .all(tenantId, pauseId)
      .map(toMailbox);
  }

  /** Writes the mailbox whole: a new row, or over its own. */
  put(box: StoredMailbox): void {
    this.database
      .prepare(
        `INSERT INTO pause_notices (tenant_id, pause_id, recipient, notices, delivered, attempts,
           next_attempt_at, head_written_at, is_dead, problem, claim_token, claimed_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, pause_id, recipient) DO UPDATE SET notices = excluded.notices,
           delivered = excluded.delivered, attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at, head_written_at = excluded.head_written_at,
           is_dead = excluded.is_dead, problem = excluded.problem,
           claim_token = excluded.claim_token, claimed_until = excluded.claimed_until`,
      )
      .run(
        box.tenantId,
        box.pauseId,
        box.recipient,
        JSON.stringify(box.notices),
        box.delivered,
        box.attempts,
        box.nextAttemptAt.toISOString(),
        box.headWrittenAt ?? null,
        box.isDead ? 1 : 0,
        box.problem ?? null,
        box.claim?.token ?? null,
        box.claim?.until.toISOString() ?? null,
      );
  }

  /** The planned notices appended to their mailboxes (created when absent). */
  append(pause: PauseRecord, notices: readonly PlannedNotice[]): void {
    for (const planned of notices)
      this.put(
        appendedMailbox(
          this.find(pause.tenantId, pause.pauseId, planned.recipient),
          pause,
          planned,
        ),
      );
  }

  /** Whether any mailbox of the pause has a notice of `kind`. */
  hasNoticeOf(tenantId: string, pauseId: string, kind: PauseNoticeKind): boolean {
    return this.ofPause(tenantId, pauseId).some((box) => hasNoticeOf(box, kind));
  }

  /** Claims up to `limit` due mailboxes of `recipients`, oldest due first, under fresh tokens. */
  claimDue(
    at: Date,
    limit: number,
    claimFor: number,
    recipients: readonly string[],
    newToken: () => string,
  ): PauseNoticeClaim[] {
    if (recipients.length === 0) return [];
    const marks = recipients.map(() => "?").join(", ");
    const now = at.toISOString();
    const due = this.database
      .prepare(
        `SELECT * FROM pause_notices WHERE recipient IN (${marks}) AND is_dead = 0
           AND head_written_at IS NOT NULL AND next_attempt_at <= ?
           AND (claim_token IS NULL OR claimed_until <= ?) ORDER BY next_attempt_at LIMIT ?`,
      )
      .all(...recipients, now, now, limit)
      .map(toMailbox);
    return due.map((box) => {
      const until = new Date(at.getTime() + claimFor);
      const token = newToken();
      const claimed = claimedMailbox(box, token, until);
      this.put(claimed);
      return { mailbox: mailboxOf(claimed), token, until };
    });
  }

  /** The mailbox `claim` names while the claim's token is still its own. */
  held(claim: PauseNoticeClaim): StoredMailbox | undefined {
    const { tenantId, pauseId, recipient } = claim.mailbox;
    const box = this.find(tenantId, pauseId, recipient);
    return box !== undefined && isHeldBy(box, claim.token) ? box : undefined;
  }

  ack(claim: PauseNoticeClaim, at: Date): PauseNoticeClaim | undefined {
    const held = this.held(claim);
    const until = held?.claim?.until;
    if (held === undefined || until === undefined || until <= at) return undefined;
    const acknowledged = acknowledgedMailbox(held, at);
    this.put(acknowledged);
    return acknowledged.claim === undefined
      ? undefined
      : { mailbox: mailboxOf(acknowledged), token: claim.token, until: acknowledged.claim.until };
  }

  retry(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): boolean {
    const held = this.held(claim);
    if (held !== undefined) this.put(retriedMailbox(held, nextAttemptAt, problem));
    return held !== undefined;
  }

  setAside(claim: PauseNoticeClaim, problem: string): boolean {
    const held = this.held(claim);
    if (held !== undefined) this.put(setAsideMailbox(held, problem));
    return held !== undefined;
  }

  /** Sets aside live mailboxes whose head was written before `writtenBefore` and are unclaimed. */
  setAsideStale(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): readonly SetAsideMailbox[] {
    const stale = this.database
      .prepare(
        `SELECT * FROM pause_notices WHERE is_dead = 0 AND head_written_at IS NOT NULL
           AND head_written_at < ? AND (claim_token IS NULL OR claimed_until <= ?)
           ORDER BY head_written_at LIMIT ?`,
      )
      .all(writtenBefore.toISOString(), at.toISOString(), limit)
      .map(toMailbox);
    for (const box of stale) this.put(setAsideMailbox(box, problem));
    return stale.map(({ tenantId, pauseId, recipient }) => ({ tenantId, pauseId, recipient }));
  }

  count(): PauseNoticeCounts {
    const row = z.object({ live: z.number().nullable(), dead: z.number().nullable() }).parse(
      this.database
        .prepare(
          `SELECT SUM(is_dead = 0 AND head_written_at IS NOT NULL) AS live, SUM(is_dead = 1) AS dead
               FROM pause_notices`,
        )
        .get(),
    );
    return { live: row.live ?? 0, dead: row.dead ?? 0 };
  }

  /** Whether any mailbox of the pause keeps it (neither fully delivered nor dead). */
  hasLive(tenantId: string, pauseId: string): boolean {
    return this.ofPause(tenantId, pauseId).some(isLive);
  }
}
