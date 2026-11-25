import { z } from "zod";
import { PauseClosedReason, pauseKeyOf } from "../pause-record.js";
import type { StoredMailbox } from "../pause-mailboxes.js";
import { PauseNoticeKind } from "../pause-notices.js";
import { definedOf } from "../clock.js";
import { parsedStoredJson } from "../stored-step.js";

/** The `pause_notices` table (#935) and how its rows read: validated on the way out. */

const StoredNotice = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: z.string(),
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  previousExpiresAt: z.string().optional(),
  previousAssignees: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  previousTarget: z.string().optional(),
  previousChannel: z.string().optional(),
  previousExternalRef: z.string().optional(),
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
    notices: z.array(StoredNotice).parse(
      parsedStoredJson({
        what: "pause notice mailbox",
        text: r.notices,
        ids: { pause: pauseKeyOf(r.tenant_id, r.pause_id) },
      }),
    ),
    delivered: r.delivered,
    attempts: r.attempts,
    nextAttemptAt: new Date(r.next_attempt_at),
    isDead: r.is_dead === 1,
    ...(r.head_written_at === null ? {} : { headWrittenAt: r.head_written_at }),
    ...(r.problem === null ? {} : { problem: r.problem }),
    ...(r.claim_token === null
      ? {}
      : {
          claim: {
            token: r.claim_token,
            until: new Date(
              definedOf(
                r.claimed_until ?? undefined,
                "a mailbox claimed under a token is claimed until a time",
              ),
            ),
          },
        }),
  };
}
