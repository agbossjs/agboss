import { z } from "zod";
import { PauseClosedReason, pauseKeyOf } from "../pause-record.js";
import type { StoredMailbox } from "../pause-mailboxes.js";
import { PauseNoticeKind } from "../pause-notices.js";
import { definedOf } from "../clock.js";
import { instantOfText } from "../instants.js";
import { parsedStoredJson, readStored, StoredInstant } from "../stored-step.js";

/** The `pause_notices` table (#935) and how its rows read: validated on the way out; its times only as `toISOString()` writes them. */
const MAILBOX = "pause notice mailbox";

const StoredNotice = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: StoredInstant,
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: StoredInstant.optional(),
  expiresAt: StoredInstant.optional(),
  previousExpiresAt: StoredInstant.optional(),
  actor: z.object({ id: z.string(), orgId: z.string().optional() }).optional(),
  changeReason: z.string().optional(),
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
    notices: readStored(
      z.array(StoredNotice),
      parsedStoredJson({
        what: "pause notice mailbox",
        text: r.notices,
        ids: { pause: pauseKeyOf(r.tenant_id, r.pause_id) },
      }),
      "pause notice mailbox",
      [],
    ),
    delivered: r.delivered,
    attempts: r.attempts,
    nextAttemptAt: instantOfText(r.next_attempt_at, "next_attempt_at", MAILBOX),
    isDead: r.is_dead === 1,
    ...(r.head_written_at === null
      ? {}
      : { headWrittenAt: instantOfText(r.head_written_at, "head_written_at", MAILBOX) }),
    ...(r.problem === null ? {} : { problem: r.problem }),
    ...(r.claim_token === null
      ? {}
      : {
          claim: {
            token: r.claim_token,
            until: instantOfText(
              definedOf(
                r.claimed_until ?? undefined,
                "a mailbox claimed under a token is claimed until a time",
              ),
              "claimed_until",
              MAILBOX,
            ),
          },
        }),
  };
}
