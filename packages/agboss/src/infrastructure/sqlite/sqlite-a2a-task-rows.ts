import { storedUsd } from "../../finops/cost-report.js";
import { z } from "zod";
import { parsedStoredJson } from "../stored-step.js";
import { PauseKind } from "../../pause/types.js";
import {
  A2ATaskState,
  isTerminalA2ATaskState,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "../a2a-task.repository.js";

/** The rows of `SqliteA2ATaskRepository` (#807): its schema, and their records. */

export const TERMINAL_STATES = Object.values(A2ATaskState).filter(isTerminalA2ATaskState);

export const SCHEMA = `CREATE TABLE IF NOT EXISTS a2a_tasks (
  endpoint TEXT NOT NULL, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  context_id TEXT NOT NULL, skill TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, accepted_at TEXT NOT NULL, status_at TEXT NOT NULL, caller_peer TEXT,
  mesh_body_hash TEXT,
  PRIMARY KEY (tenant_id, task_id));
CREATE INDEX IF NOT EXISTS a2a_tasks_by_owner
  ON a2a_tasks (tenant_id, owner_id, status_at DESC, task_id DESC);
CREATE INDEX IF NOT EXISTS a2a_tasks_by_endpoint ON a2a_tasks (endpoint, state, status_at);
CREATE TABLE IF NOT EXISTS a2a_messages (
  endpoint TEXT NOT NULL, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, task_id TEXT NOT NULL, saved_at TEXT NOT NULL, reply TEXT,
  PRIMARY KEY (tenant_id, owner_id, message_id));
CREATE INDEX IF NOT EXISTS a2a_messages_by_task ON a2a_messages (tenant_id, task_id);
CREATE INDEX IF NOT EXISTS a2a_messages_by_endpoint ON a2a_messages (endpoint, task_id, saved_at);`;

/** `work`'s result as a store's answer: a failure (a refused page token, a corrupt row) rejects. */
export const answerOf = <T>(work: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(work());
  });

/** A time as the store writes it: `Date.toISOString()` text (no SQLite clock is read). */
const { datetime: isoTime } = z.iso;

const TaskRow = z.object({
  endpoint: z.string(),
  tenant_id: z.string(),
  task_id: z.string(),
  owner_id: z.string(),
  context_id: z.string(),
  skill: z.string(),
  state: z.enum(A2ATaskState),
  status: z.string(),
  version: z.number().int().positive(),
  accepted_at: isoTime(),
  status_at: isoTime(),
  caller_peer: z.string().nullable(),
  // added on open to a file of before #810 (its rows' none)
  mesh_body_hash: z.string().nullable(),
});

const MessageRow = z.object({
  endpoint: z.string(),
  tenant_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  request_hash: z.string(),
  task_id: z.string(),
  saved_at: isoTime(),
  reply: z.string().nullable(),
});

/** A status as written: what a corrupt column is refused by, never read as a task's state (M5). */
const Status = z.looseObject({
  state: z.enum(A2ATaskState),
  message: z.string().optional(),
  pendingPauses: z.array(
    z.looseObject({
      pauseId: z.string().optional(),
      kind: z.enum(PauseKind),
      input: z.unknown(),
      toolCall: z.unknown().optional(),
    }),
  ),
  finish: z.string().optional(),
  output: z.unknown().optional(),
  errorCode: z.string().optional(),
  errorDetails: z.unknown().optional(),
  spentUsd: storedUsd.optional(),
  spentTokens: z.number().int().nonnegative().optional(),
  cancelRequestedAt: isoTime()
    .transform((text) => new Date(text))
    .optional(),
});

/** The status of a row whose `state` column agrees with it (M6: a compare-and-set reads the column). */
function statusOf(row: z.infer<typeof TaskRow>): A2ATaskStatus {
  const status = Status.parse(
    parsedStoredJson({ what: "a2a task status", text: row.status, ids: { taskId: row.task_id } }),
  );
  if (status.state !== row.state)
    throw new Error(`a2a_tasks row ${row.task_id}: its state column and its status disagree`);
  // a loose object keeps every key the status had, those this version does not know too (#960)
  return status;
}

/** No owner is the empty text, which no owner's id is (a key's text, #589). */
export const ownerColumnOf = (ownerId: string | undefined): string => ownerId ?? "";
const ownerOf = (column: string): string | undefined => (column === "" ? undefined : column);

export const taskOf = (row: unknown): A2ATaskRecord => {
  const parsed = TaskRow.parse(row);
  return {
    endpoint: parsed.endpoint,
    tenantId: parsed.tenant_id,
    taskId: parsed.task_id,
    ownerId: ownerOf(parsed.owner_id),
    contextId: parsed.context_id,
    skill: parsed.skill,
    status: statusOf(parsed),
    version: parsed.version,
    acceptedAt: new Date(parsed.accepted_at),
    statusAt: new Date(parsed.status_at),
    ...(parsed.caller_peer === null ? {} : { callerPeer: parsed.caller_peer }),
    ...(parsed.mesh_body_hash === null ? {} : { meshBodyHash: parsed.mesh_body_hash }),
  };
};

export const messageOf = (row: unknown): A2AMessageRecord => {
  const parsed = MessageRow.parse(row);
  return {
    endpoint: parsed.endpoint,
    tenantId: parsed.tenant_id,
    ownerId: ownerOf(parsed.owner_id),
    messageId: parsed.message_id,
    requestHash: parsed.request_hash,
    taskId: parsed.task_id,
    savedAt: new Date(parsed.saved_at),
    ...(parsed.reply === null
      ? {}
      : {
          reply: parsedStoredJson({
            what: "a2a message reply",
            text: parsed.reply,
            ids: {
              messageId: parsed.message_id,
            },
          }),
        }),
  };
};

export const MESSAGE_KEY = "tenant_id = ? AND owner_id = ? AND message_id = ?";
export const messageKeyOf = (key: A2AMessageKey): readonly [string, string, string] => [
  key.tenantId,
  ownerColumnOf(key.ownerId),
  key.messageId,
];

/** The count of a `SELECT count(*) AS total` (#824). */
export const totalOf = (row: unknown): number =>
  z.object({ total: z.number().int() }).parse(row).total;
