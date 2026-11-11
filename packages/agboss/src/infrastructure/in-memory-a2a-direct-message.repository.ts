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
import {
  checkedDirectMessageLimit,
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
  directSaveOf,
  isExpiredAttempt,
  savedA2ADirectMessageOf,
} from "./a2a-direct-message-claims.js";
import { a2aMessageRowOf } from "./a2a-task-pages.js";
import { IN_MEMORY_DATABASE, type InMemoryDatabase } from "./in-memory-database.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";

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
    return Promise.resolve(structuredClone(this.database.a2aDirectMessages.get(a2aMessageRowOf(key))));
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
    // the claims of the removed, and those whose message went before (a failed attempt's)
    for (const [row, claim] of claims) {
      const isOld = claim.savedAt.getTime() < cutoff.getTime();
      if (claim.taskId === DIRECT_MESSAGE_CLAIM && isOld && !messages.has(row)) claims.delete(row);
    }
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
