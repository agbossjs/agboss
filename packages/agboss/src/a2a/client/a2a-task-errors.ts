import type { Message } from "@a2a-js/sdk";

/** A task id or context id a remote gave, as the client keeps it: a key's text of a safe charset. */
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

/** `id` when it is one the client may keep and show, else `undefined` (never a free text). */
export const safeTaskIdOf = (id: unknown): string | undefined =>
  typeof id === "string" && SAFE_ID.test(id) ? id : undefined;

/**
 * How a remote task ended without an output, as the call fails with it (#809, design §4.2
 * "Outcomes"): its ids (checked when they came, `safeTaskIdOf`), how it ended, an AGBoss peer's
 * stable code — never the task's status text.
 */

/** How an A2A task ended without an output (the spec's state names). */
export enum A2ATaskEnd {
  Failed = "failed",
  Rejected = "rejected",
}

/** Why a task waits for its caller. */
export enum A2ATaskInterruption {
  InputRequired = "input-required",
  AuthRequired = "auth-required",
}

/** How the best-effort cancel at a deadline went. */
export enum A2ACancelOutcome {
  /** The agent answered the task CANCELED. */
  Cancelled = "cancelled",
  /** The agent answered, the task in another state (it may still end on its side). */
  NotCancelled = "not-cancelled",
  /** The agent refused it (an error answer: the task not cancelable, the caller refused, …). */
  Refused = "refused",
  /** No answer within the cancel's own bound. */
  NoAnswer = "no-answer",
}

/** Whether a message's ids are safe ids (#860): its `messageId`, its `contextId` when it has one. */
export const hasSafeIds = (message: Pick<Message, "messageId" | "contextId">): boolean =>
  safeTaskIdOf(message.messageId) !== undefined &&
  (message.contextId === "" || safeTaskIdOf(message.contextId) !== undefined);
