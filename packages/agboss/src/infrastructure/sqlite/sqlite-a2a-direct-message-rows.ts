import { z } from "zod";
import {
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
} from "../a2a-direct-message.repository.js";
import { ownerColumnOf } from "./sqlite-a2a-task-rows.js";

/** The rows of `SqliteA2ADirectMessageRepository` (#860): its schema, and their records. */

export const DIRECT_SCHEMA = `CREATE TABLE IF NOT EXISTS a2a_direct_messages (
  tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, skill TEXT NOT NULL, context_id TEXT NOT NULL, state TEXT NOT NULL,
  attempt_id TEXT NOT NULL, calls_model INTEGER NOT NULL, created_at TEXT NOT NULL,
  started_at TEXT NOT NULL, expires_at TEXT NOT NULL, caller_peer TEXT, mesh_body_hash TEXT,
  reply TEXT, completed_at TEXT,
  PRIMARY KEY (tenant_id, owner_id, message_id));
CREATE INDEX IF NOT EXISTS a2a_direct_messages_in_flight
  ON a2a_direct_messages (state, expires_at);
CREATE INDEX IF NOT EXISTS a2a_direct_messages_by_age ON a2a_direct_messages (created_at);`;

/** A time as the store writes it: `Date.toISOString()` text (no SQLite clock is read). */
const { datetime: isoTime } = z.iso;

const DirectRow = z.object({
  tenant_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  request_hash: z.string(),
  skill: z.string(),
  context_id: z.string(),
  state: z.enum(A2ADirectMessageState),
  attempt_id: z.string(),
  calls_model: z.union([z.literal(0), z.literal(1)]),
  created_at: isoTime(),
  started_at: isoTime(),
  expires_at: isoTime(),
  caller_peer: z.string().nullable(),
  mesh_body_hash: z.string().nullable(),
  reply: z.string().nullable(),
  completed_at: isoTime().nullable(),
});

/** A kept reply, as written: what a corrupt column is refused by. */
const Reply = z.strictObject({
  finish: z.string(),
  output: z.unknown(),
  spentUsd: z.number().nonnegative(),
});

/** The reply of a row whose state says it has one, and only then (a corrupt row is refused). */
function replyOf(
  row: z.infer<typeof DirectRow>,
): Pick<A2ADirectMessageRecord, "reply" | "completedAt"> {
  const { reply, completed_at: completedAt } = row;
  const disagree = () =>
    new Error(`a2a_direct_messages row ${row.message_id}: its state and its reply disagree`);
  if (row.state === A2ADirectMessageState.InFlight) {
    if (reply !== null || completedAt !== null) throw disagree();
    return {};
  }
  if (reply === null || completedAt === null) throw disagree();
  const kept = Reply.parse(JSON.parse(reply));
  return {
    reply: { finish: kept.finish, output: kept.output, spentUsd: kept.spentUsd },
    completedAt: new Date(completedAt),
  };
}

export const directMessageOf = (row: unknown): A2ADirectMessageRecord => {
  const parsed = DirectRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    ownerId: parsed.owner_id === "" ? undefined : parsed.owner_id,
    messageId: parsed.message_id,
    requestHash: parsed.request_hash,
    skill: parsed.skill,
    contextId: parsed.context_id,
    state: parsed.state,
    attemptId: parsed.attempt_id,
    startedAt: new Date(parsed.started_at),
    expiresAt: new Date(parsed.expires_at),
    callsModel: parsed.calls_model === 1,
    createdAt: new Date(parsed.created_at),
    ...(parsed.caller_peer === null ? {} : { callerPeer: parsed.caller_peer }),
    ...(parsed.mesh_body_hash === null ? {} : { meshBodyHash: parsed.mesh_body_hash }),
    ...replyOf(parsed),
  };
};

/** A row's columns in `INSERT` order. */
export const directColumnsOf = (
  message: A2ADirectMessageRecord,
): readonly (string | number | null)[] => [
  message.tenantId,
  ownerColumnOf(message.ownerId),
  message.messageId,
  message.requestHash,
  message.skill,
  message.contextId,
  message.state,
  message.attemptId,
  message.callsModel ? 1 : 0,
  message.createdAt.toISOString(),
  message.startedAt.toISOString(),
  message.expiresAt.toISOString(),
  message.callerPeer ?? null,
  message.meshBodyHash ?? null,
];

export const INSERT_DIRECT = `INSERT INTO a2a_direct_messages (tenant_id, owner_id, message_id,
  request_hash, skill, context_id, state, attempt_id, calls_model, created_at, started_at,
  expires_at, caller_peer, mesh_body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
