import type { A2AMessageRecord } from "./a2a-task.repository.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";

/**
 * Infrastructure (#860, A2A v1.0 design §4.1.8): the short-lived replies of the skills that answer
 * with a direct `Message` (`A2AReply.Message`) — no task, no durable execution of the caller's to
 * follow. One row per accepted message, keyed `(tenantId, ownerId, messageId)`: `InFlight` while
 * an attempt makes its reply (bounded by `expiresAt`), `Completed` with the reply once made — a
 * resend within `@Application({ retention: { a2aMessages } })` (default `minutes(15)`) gets it,
 * never a second run of the skill. A failed reply is not kept.
 *
 * One `messageId` is one message across both reply modes: `saveIfAbsent` claims the id among the
 * A2A task store's messages (`A2ATaskRepository`, a claim of no task: `taskId` `""`) in the same
 * atomic write as its row, so a task message and a direct message never share an id — the store
 * lives on its task store's backend (`[a2a.message-store-not-shared]`). Listed only in
 * `@Application({ providers })`; the built-in default is in memory (`InMemoryA2ADirectMessageRepository`),
 * `SqliteA2ADirectMessageRepository` shares the replies between instances on one file. A store of
 * your own proves itself with `a2aDirectMessageContract` (`@agboss/core/testing/contracts`).
 */

/** Where a direct message's reply is. */
export enum A2ADirectMessageState {
  /** An attempt makes it, until its `expiresAt`: a resend waits for it. */
  InFlight = "in-flight",
  /** Made: a resend gets it. It never changes again. */
  Completed = "completed",
}

/** A direct message's key: its tenant, its caller and the id its author gave it. */
export interface A2ADirectMessageKey {
  readonly tenantId: string;
  /** The resolved caller (`undefined`: none); another owner's message id is another message. */
  readonly ownerId: string | undefined;
  readonly messageId: string;
}

/** A completed reply: the finish its run reached and the finish's output, plain JSON. */
export interface A2ADirectMessageReply {
  readonly finish: string;
  readonly output: unknown;
  /** What the run spent in all, in USD: what a trusted caller's run report signs. */
  readonly spentUsd: number;
}

/** One attempt at a reply: its root execution's id, when it began and until when it may run. */
export interface A2ADirectMessageAttempt {
  /** The attempt's root execution id (reserved, never reused): its files' owner too. */
  readonly attemptId: string;
  readonly startedAt: Date;
  /** Past it a resend (or the sweep) takes the attempt as lost: its run was bounded below it. */
  readonly expiresAt: Date;
}

/** A direct message as kept. */
export interface A2ADirectMessageRecord extends A2ADirectMessageKey, A2ADirectMessageAttempt {
  /** The hash of what the message asked: a resend with another one is not the same message. */
  readonly requestHash: string;
  /** The skill (the exported start's name) it runs. */
  readonly skill: string;
  /** Its A2A `contextId`: its runs' thread. */
  readonly contextId: string;
  readonly state: A2ADirectMessageState;
  /**
   * Whether the skill's workflow can call a model (#853): an attempt lost after it began records
   * one entry of unknown cost (`CostSource.Unknown`) when it is taken over or swept.
   */
  readonly callsModel: boolean;
  /** When it was first accepted, on the application's clock: what the retention counts from. */
  readonly createdAt: Date;
  /** The authenticated mesh peer that sent it, if any. */
  readonly callerPeer?: string;
  /** The `bodyHash` of a message whose envelope the authenticated peer signed: its report binds it. */
  readonly meshBodyHash?: string;
  /** The reply (`Completed`). */
  readonly reply?: A2ADirectMessageReply;
  /** When the reply was kept (`Completed`): the date of its run report. */
  readonly completedAt?: Date;
}

/** A message to accept: its first attempt begins with it. */
export type NewA2ADirectMessage = Omit<A2ADirectMessageRecord, "state" | "reply" | "completedAt">;

/** What `saveIfAbsent` did. */
export enum A2ADirectMessageSaveStatus {
  /** Saved `InFlight`: this call runs its first attempt. */
  Saved = "saved",
  /** The message was accepted before: its row as kept (its hash compared by the caller). */
  Kept = "kept",
  /** The id is another message's — a task's, or a direct one of other content: nothing saved. */
  Taken = "taken",
}

export type A2ADirectMessageSave =
  | {
      readonly status: A2ADirectMessageSaveStatus.Saved | A2ADirectMessageSaveStatus.Kept;
      readonly message: A2ADirectMessageRecord;
    }
  | { readonly status: A2ADirectMessageSaveStatus.Taken };

export abstract class A2ADirectMessageRepository {
  /**
   * The backend the store's rows live in (as `A2ATaskRepository.store`): its task store's, whose
   * messages it claims ids among (`[a2a.message-store-not-shared]`). Unset: undeclared.
   */
  static readonly store: StoreDescriptor = { backend: undefined };

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Accepts a message `InFlight`, atomically with its id's claim among the task store's messages:
   * saved; or — accepted before — its row; or — the id another message's — nothing.
   */
  abstract saveIfAbsent(message: NewA2ADirectMessage): Promise<A2ADirectMessageSave>;

  abstract findByKey(key: A2ADirectMessageKey): Promise<A2ADirectMessageRecord | undefined>;

  /**
   * Keeps the reply of attempt `attemptId` only while the message is `InFlight` under it,
   * atomically: the message as written (`Completed`), else `undefined` — nothing written.
   */
  abstract completeIfInFlight(
    key: A2ADirectMessageKey,
    attemptId: string,
    reply: A2ADirectMessageReply,
    completedAt: Date,
  ): Promise<A2ADirectMessageRecord | undefined>;

  /**
   * Starts attempt `next` in place of `expiredAttemptId` only while the message is `InFlight` under
   * it with `expiresAt <= now` (the caller's clock), atomically: the message as written, else
   * `undefined`. Of two instances taking one lost attempt over, exactly one gets it.
   */
  abstract retakeIfExpired(
    key: A2ADirectMessageKey,
    expiredAttemptId: string,
    next: A2ADirectMessageAttempt,
    now: Date,
  ): Promise<A2ADirectMessageRecord | undefined>;

  /**
   * Removes the message while it is `InFlight` under `attemptId` (its attempt failed, or was lost
   * and swept); `true` when this call removed it. Its id stays claimed until the retention: a
   * resend of the same message runs again, another message under the id is still refused.
   */
  abstract deleteIfInFlight(key: A2ADirectMessageKey, attemptId: string): Promise<boolean>;

  /** At most `limit` messages `InFlight` with `expiresAt <= now`, the oldest expiry first. */
  abstract findAllInFlightByExpiresAtBefore(
    now: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]>;

  /**
   * Removes at most `limit` messages accepted before `cutoff` — the oldest first, with the claims
   * of their ids, and the claims left by removed `InFlight` ones — and gives back the messages it
   * removed (their attempts' files go next).
   */
  abstract deleteByCreatedAtBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]>;
}

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
