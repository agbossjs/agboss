import type { A2AMessageRecord } from "./a2a-task.repository.js";
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
  type A2ADirectMessageSave,
  type NewA2ADirectMessage,
} from "./a2a-direct-message.repository.js";

/**
 * What every `A2ADirectMessageRepository` shares (#860): a new message's row, a page's checked
 * limit, and the claim of its id among the A2A task store's messages — a claim of no task (`taskId`
 * `""`) — with what `saveIfAbsent` answers for what it found.
 */

/** A message as `saveIfAbsent` keeps it: `InFlight`, its first attempt. */
export const savedA2ADirectMessageOf = (message: NewA2ADirectMessage): A2ADirectMessageRecord => ({
  tenantId: message.tenantId,
  ownerId: message.ownerId,
  messageId: message.messageId,
  requestHash: message.requestHash,
  skill: message.skill,
  contextId: message.contextId,
  state: A2ADirectMessageState.InFlight,
  attemptId: message.attemptId,
  startedAt: message.startedAt,
  expiresAt: message.expiresAt,
  callsModel: message.callsModel,
  createdAt: message.createdAt,
  ...(message.callerPeer === undefined ? {} : { callerPeer: message.callerPeer }),
  ...(message.meshBodyHash === undefined ? {} : { meshBodyHash: message.meshBodyHash }),
});

/** A page's limit, checked: a whole number from 1, so a sweep's paging always ends. */
export function checkedDirectMessageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(
      `a page of direct A2A messages holds a whole number from 1, not ${String(limit)}`,
    );
  return limit;
}

/** The task id of a direct message's claim among the task store's messages: no task has it. */
export const DIRECT_MESSAGE_CLAIM = "";

/** What a direct message claims among the task store's messages: its id, of no task. */
export const directMessageClaimOf = (message: NewA2ADirectMessage): A2AMessageRecord => ({
  tenantId: message.tenantId,
  ownerId: message.ownerId,
  messageId: message.messageId,
  requestHash: message.requestHash,
  taskId: DIRECT_MESSAGE_CLAIM,
  savedAt: message.createdAt,
});

/** What a store found of a message's id: the claim among the task store's messages, its own row. */
export interface DirectMessageFound {
  readonly claim: { readonly requestHash: string; readonly taskId: string } | undefined;
  readonly kept: A2ADirectMessageRecord | undefined;
}

/**
 * What `saveIfAbsent` answers for what a store found, in its atomic write: the row kept; the id
 * another message's (a task's claim, or a direct claim of other content); else `undefined` — save it.
 */
export function directSaveOf(
  found: DirectMessageFound,
  message: NewA2ADirectMessage,
): A2ADirectMessageSave | undefined {
  if (found.kept !== undefined)
    return { status: A2ADirectMessageSaveStatus.Kept, message: found.kept };
  const { claim } = found;
  const isOthers =
    claim !== undefined &&
    (claim.taskId !== DIRECT_MESSAGE_CLAIM || claim.requestHash !== message.requestHash);
  return isOthers ? { status: A2ADirectMessageSaveStatus.Taken } : undefined;
}

/** Whether attempt `attemptId` of a kept message is in flight and over by `now`. */
export const isExpiredAttempt = (
  message: A2ADirectMessageRecord,
  attemptId: string,
  now: Date,
): boolean =>
  message.state === A2ADirectMessageState.InFlight &&
  message.attemptId === attemptId &&
  message.expiresAt.getTime() <= now.getTime();
