import {
  A2ADirectMessageSaveStatus,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
  type A2ADirectMessageRepository,
  type NewA2ADirectMessage,
} from "../../infrastructure/a2a-direct-message.repository.js";
import type { A2ATaskRepository } from "../../infrastructure/a2a-task.repository.js";
import { NUL_TEXT } from "./nul-text.js";

/** The data of the direct-message contract's cases (#860). */

/**
 * What the direct-message contract runs on: the store under test and the A2A task store it claims
 * message ids among — both on one backing store, as an application lists them.
 */
export interface A2ADirectMessageStores {
  readonly messages: A2ADirectMessageRepository;
  readonly tasks: A2ATaskRepository;
}

export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const at = (seconds: number): Date => new Date(NINE.getTime() + seconds * 1000);

/** A message of alice accepted at nine, its first attempt bounded at nine plus 30 s. */
export const newMessage = (
  messageId: string,
  overrides: Partial<NewA2ADirectMessage> = {},
): NewA2ADirectMessage => ({
  tenantId: "default",
  ownerId: "alice",
  messageId,
  requestHash: "h-1",
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  attemptId: `run-${messageId}`,
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: true,
  createdAt: NINE,
  ...overrides,
});

export const keyOf = (message: A2ADirectMessageKey): A2ADirectMessageKey => ({
  tenantId: message.tenantId,
  ownerId: message.ownerId,
  messageId: message.messageId,
});

/** A reply with nested JSON and a NUL character (#521). */
export const REPLY: A2ADirectMessageReply = {
  finish: "quote-workflow-finish",
  output: { text: NUL_TEXT, lines: [{ sku: "a", amount: 12.5 }], paid: true },
  spentUsd: 0.0125,
};

/** The message `saveIfAbsent` saved; fails the case when it did not. */
export async function savedMessage(
  store: A2ADirectMessageRepository,
  message: NewA2ADirectMessage,
): Promise<A2ADirectMessageRecord> {
  const save = await store.saveIfAbsent(message);
  if (save.status !== A2ADirectMessageSaveStatus.Saved)
    throw new Error(`${message.messageId}: ${save.status}`);
  return save.message;
}
