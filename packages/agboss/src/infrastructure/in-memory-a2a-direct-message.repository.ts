import { Injectable } from "../components/decorators.js";
import {
  A2ADirectMessageRepository,
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type A2ADirectMessageAttempt,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
  type A2ADirectMessageSave,
  type NewA2ADirectMessage,
} from "./a2a-direct-message.repository.js";
import { a2aMessageRowOf } from "./a2a-task-pages.js";
import type { A2AMessageRecord } from "./a2a-task.repository.js";
import { IN_MEMORY_DATABASE, type InMemoryDatabase } from "./in-memory-database.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";

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

/** `work`'s result as a store's answer: a refused limit rejects, never throws. */
const answered = <T>(work: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(work());
  });

/** A value as plain JSON, as the SQLite store keeps it: one comparison for both. */
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The built-in default (#860): the direct messages in this instance's memory, a copy of each in
 * and out — their ids claimed among the in-memory task store's messages (`InMemoryDatabase`).
 */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryA2ADirectMessageRepository extends A2ADirectMessageRepository {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveIfAbsent(message: NewA2ADirectMessage): Promise<A2ADirectMessageSave> {
    const row = a2aMessageRowOf(message);
    const { a2aMessages: claims, a2aDirectMessages: messages } = this.database;
    const found = { claim: claims.get(row), kept: structuredClone(messages.get(row)) };
    const answer = directSaveOf(found, message);
    if (answer !== undefined) return Promise.resolve(answer);
    const saved = savedA2ADirectMessageOf(message);
    if (found.claim === undefined) claims.set(row, directMessageClaimOf(message));
    messages.set(row, structuredClone(saved));
    return Promise.resolve({ status: A2ADirectMessageSaveStatus.Saved, message: saved });
  }

  findByKey(key: A2ADirectMessageKey): Promise<A2ADirectMessageRecord | undefined> {
    return Promise.resolve(
      structuredClone(this.database.a2aDirectMessages.get(a2aMessageRowOf(key))),
    );
  }

  completeIfInFlight(
    key: A2ADirectMessageKey,
    attemptId: string,
    reply: A2ADirectMessageReply,
    completedAt: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    return this.#changed(key, attemptId, (kept) => ({
      ...kept,
      state: A2ADirectMessageState.Completed,
      reply: asStored(reply),
      completedAt,
    }));
  }

  retakeIfExpired(
    key: A2ADirectMessageKey,
    expiredAttemptId: string,
    next: A2ADirectMessageAttempt,
    now: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const kept = this.database.a2aDirectMessages.get(a2aMessageRowOf(key));
    if (kept === undefined || !isExpiredAttempt(kept, expiredAttemptId, now))
      return Promise.resolve(undefined);
    return this.#changed(key, expiredAttemptId, (found) => ({ ...found, ...next }));
  }

  deleteIfInFlight(key: A2ADirectMessageKey, attemptId: string): Promise<boolean> {
    const row = a2aMessageRowOf(key);
    const kept = this.database.a2aDirectMessages.get(row);
    const isIt = kept?.state === A2ADirectMessageState.InFlight && kept.attemptId === attemptId;
    if (isIt) this.database.a2aDirectMessages.delete(row);
    return Promise.resolve(isIt);
  }

  findAllInFlightByExpiresAtBefore(
    now: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    return answered(() =>
      structuredClone(
        [...this.database.a2aDirectMessages.values()]
          .filter((kept) => kept.state === A2ADirectMessageState.InFlight)
          .filter((kept) => kept.expiresAt.getTime() <= now.getTime())
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
          .slice(0, checkedDirectMessageLimit(limit)),
      ),
    );
  }

  deleteByCreatedAtBefore(cutoff: Date, limit: number): Promise<readonly A2ADirectMessageRecord[]> {
    return answered(() => this.#removedBefore(cutoff, checkedDirectMessageLimit(limit)));
  }

  #removedBefore(cutoff: Date, limit: number): readonly A2ADirectMessageRecord[] {
    const { a2aMessages: claims, a2aDirectMessages: messages } = this.database;
    const gone = [...messages.entries()]
      .filter(([, kept]) => kept.createdAt.getTime() < cutoff.getTime())
      .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const [row] of gone) messages.delete(row);
    for (const [row] of gone)
      if (claims.get(row)?.taskId === DIRECT_MESSAGE_CLAIM) claims.delete(row);
    // at most `limit` claims more, of messages that went before (a failed attempt's)
    const orphans = [...claims.entries()].filter(
      ([row, claim]) =>
        claim.taskId === DIRECT_MESSAGE_CLAIM &&
        claim.savedAt.getTime() < cutoff.getTime() &&
        !messages.has(row),
    );
    for (const [row] of orphans.slice(0, limit)) claims.delete(row);
    return gone.map(([, kept]) => kept);
  }

  /** The message changed by `change` while `InFlight` under `attemptId`; `undefined` otherwise. */
  #changed(
    key: A2ADirectMessageKey,
    attemptId: string,
    change: (kept: A2ADirectMessageRecord) => A2ADirectMessageRecord,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const row = a2aMessageRowOf(key);
    const kept = this.database.a2aDirectMessages.get(row);
    if (kept?.state !== A2ADirectMessageState.InFlight || kept.attemptId !== attemptId)
      return Promise.resolve(undefined);
    const written = change(kept);
    this.database.a2aDirectMessages.set(row, structuredClone(written));
    return Promise.resolve(structuredClone(written));
  }
}
