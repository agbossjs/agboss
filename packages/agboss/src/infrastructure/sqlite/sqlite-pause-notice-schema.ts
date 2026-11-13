import { z } from "zod";
import { PauseClosedReason } from "../pause-record.js";
import type { StoredMailbox } from "../pause-mailboxes.js";
import { PauseNoticeKind } from "../pause-notices.js";

/** The `pause_notices` table (#935) and how its rows read: validated on the way out. */

export const NOTICES_SCHEMA = `CREATE TABLE IF NOT EXISTS pause_notices (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, recipient TEXT NOT NULL, notices TEXT NOT NULL,
  delivered INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
  head_written_at TEXT, is_dead INTEGER NOT NULL, problem TEXT, claim_token TEXT, claimed_until TEXT,
  PRIMARY KEY (tenant_id, pause_id, recipient));
CREATE INDEX IF NOT EXISTS pause_notices_due ON pause_notices (is_dead, next_attempt_at);`;

const StoredNotice = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: z.string(),
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  previousExpiresAt: z.string().optional(),
  launch: z.string().optional(),
  errorCode: z.string().optional(),
});

const MailboxRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  recipient: z.string(),
  notices: z.string(),
  delivered: z.number(),
  attempts: z.number(),
  next_attempt_at: z.string(),
  head_written_at: z.string().nullable(),
  is_dead: z.number(),
  problem: z.string().nullable(),
  claim_token: z.string().nullable(),
  claimed_until: z.string().nullable(),
});

/** A mailbox row as the mailbox it keeps. */
export function toMailbox(row: unknown): StoredMailbox {
  const r = MailboxRow.parse(row);
  return {
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    recipient: r.recipient,
    notices: z.array(StoredNotice).parse(JSON.parse(r.notices)),
    delivered: r.delivered,
    attempts: r.attempts,
    nextAttemptAt: new Date(r.next_attempt_at),
    isDead: r.is_dead === 1,
    ...(r.head_written_at === null ? {} : { headWrittenAt: r.head_written_at }),
    ...(r.problem === null ? {} : { problem: r.problem }),
    ...(r.claim_token === null || r.claimed_until === null
      ? {}
      : { claim: { token: r.claim_token, until: new Date(r.claimed_until) } }),
  };
}
