import { z } from "zod";
import type {
  A2AMessageKey,
  A2AMessageRecord,
  A2ATaskRecord,
  A2ATaskStatus,
} from "../a2a-task.repository.js";

/** The rows of `SqliteA2ATaskRepository` (#807) and their records. */

const TaskRow = z.object({
  tenant_id: z.string(),
  task_id: z.string(),
  owner_id: z.string(),
  context_id: z.string(),
  skill: z.string(),
  status: z.string(),
  version: z.number(),
  accepted_at: z.string(),
  status_at: z.string(),
  caller_peer: z.string().nullable(),
});

const MessageRow = z.object({
  tenant_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  request_hash: z.string(),
  task_id: z.string(),
  saved_at: z.string(),
  reply: z.string().nullable(),
});

/** No owner is the empty text, which no owner's id is (a key's text, #589). */
export const ownerColumnOf = (ownerId: string | undefined): string => ownerId ?? "";
const ownerOf = (column: string): string | undefined => (column === "" ? undefined : column);

export const taskOf = (row: unknown): A2ATaskRecord => {
  const parsed = TaskRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    taskId: parsed.task_id,
    ownerId: ownerOf(parsed.owner_id),
    contextId: parsed.context_id,
    skill: parsed.skill,
    // the column holds what `compareAndSetStatus` / `saveIfAbsent` wrote: an `A2ATaskStatus`
    status: JSON.parse(parsed.status) as A2ATaskStatus,
    version: parsed.version,
    acceptedAt: new Date(parsed.accepted_at),
    statusAt: new Date(parsed.status_at),
    ...(parsed.caller_peer === null ? {} : { callerPeer: parsed.caller_peer }),
  };
};

export const messageOf = (row: unknown): A2AMessageRecord => {
  const parsed = MessageRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    ownerId: ownerOf(parsed.owner_id),
    messageId: parsed.message_id,
    requestHash: parsed.request_hash,
    taskId: parsed.task_id,
    savedAt: new Date(parsed.saved_at),
    ...(parsed.reply === null ? {} : { reply: JSON.parse(parsed.reply) as unknown }),
  };
};

export const MESSAGE_KEY = "tenant_id = ? AND owner_id = ? AND message_id = ?";
export const messageKeyOf = (key: A2AMessageKey): readonly [string, string, string] => [
  key.tenantId,
  ownerColumnOf(key.ownerId),
  key.messageId,
];
