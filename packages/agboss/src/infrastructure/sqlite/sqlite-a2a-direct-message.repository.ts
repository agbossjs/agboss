import { Injectable } from "../../components/decorators.js";
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
} from "../a2a-direct-message.repository.js";
import {
  checkedDirectMessageLimit,
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
  directSaveOf,
  isExpiredAttempt,
  savedA2ADirectMessageOf,
} from "../in-memory-a2a-direct-message.repository.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";
import { answerOf, MESSAGE_KEY, messageKeyOf, messageOf, SCHEMA } from "./sqlite-a2a-task-rows.js";
import {
  DIRECT_SCHEMA,
  directColumnsOf,
  directMessageOf,
  INSERT_DIRECT,
} from "./sqlite-a2a-direct-message-rows.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * `A2ADirectMessageRepository` on the application's SQLite file (#860): a row per direct message,
 * its id claimed in the A2A task store's `a2a_messages` (a claim of no task) in the same
 * `BEGIN IMMEDIATE` transaction — so a task message and a direct message never share an id, and of
 * two instances accepting one message exactly one saves it. Every write that checks first is one
 * transaction. Listed in `@Application({ providers })` beside `SqliteA2ATaskRepository`; needs
 * `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteA2ADirectMessageRepository extends A2ADirectMessageRepository {
  static override readonly store: StoreDescriptor = { backend: "sqlite" };

  constructor(private readonly connection: SqliteConnection) {
    super();
    // Stryker disable next-line StringLiteral: the names only keep each schema run once per connection
    connection.ensureSchema("a2a_tasks", SCHEMA);
    // Stryker disable next-line StringLiteral: as above
    connection.ensureSchema("a2a_direct_messages", DIRECT_SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(message: NewA2ADirectMessage): Promise<A2ADirectMessageSave> {
    return answerOf(() =>
      this.connection.transaction((): A2ADirectMessageSave => {
        const claim = this.connection.database
          .prepare(`SELECT * FROM a2a_messages WHERE ${MESSAGE_KEY}`)
          .get(...messageKeyOf(message));
        const found = {
          claim: claim === undefined ? undefined : messageOf(claim),
          kept: this.#message(message),
        };
        const answer = directSaveOf(found, message);
        if (answer !== undefined) return answer;
        if (found.claim === undefined) this.#insertClaim(message);
        const saved = savedA2ADirectMessageOf(message);
        this.connection.database.prepare(INSERT_DIRECT).run(...directColumnsOf(saved));
        return { status: A2ADirectMessageSaveStatus.Saved, message: saved };
      }),
    );
  }

  findByKey(key: A2ADirectMessageKey): Promise<A2ADirectMessageRecord | undefined> {
    return answerOf(() => this.#message(key));
  }

  completeIfInFlight(
    key: A2ADirectMessageKey,
    attemptId: string,
    reply: A2ADirectMessageReply,
    completedAt: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    return answerOf(() =>
      this.connection.transaction(() => {
        const { changes } = this.connection.database
          .prepare(
            `UPDATE a2a_direct_messages SET state = ?, reply = ?, completed_at = ?
             WHERE ${MESSAGE_KEY} AND state = ? AND attempt_id = ?`,
          )
          .run(
            A2ADirectMessageState.Completed,
            JSON.stringify(reply),
            completedAt.toISOString(),
            ...messageKeyOf(key),
            A2ADirectMessageState.InFlight,
            attemptId,
          );
        return Number(changes) === 1 ? this.#message(key) : undefined;
      }),
    );
  }

  retakeIfExpired(
    key: A2ADirectMessageKey,
    expiredAttemptId: string,
    next: A2ADirectMessageAttempt,
    now: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    return answerOf(() =>
      this.connection.transaction(() => {
        const kept = this.#message(key);
        if (kept === undefined || !isExpiredAttempt(kept, expiredAttemptId, now)) return undefined;
        this.connection.database
          .prepare(
            `UPDATE a2a_direct_messages SET attempt_id = ?, started_at = ?, expires_at = ?
             WHERE ${MESSAGE_KEY}`,
          )
          .run(
            next.attemptId,
            next.startedAt.toISOString(),
            next.expiresAt.toISOString(),
            ...messageKeyOf(key),
          );
        return this.#message(key);
      }),
    );
  }

  deleteIfInFlight(key: A2ADirectMessageKey, attemptId: string): Promise<boolean> {
    return answerOf(() => {
      const { changes } = this.connection.database
        .prepare(
          `DELETE FROM a2a_direct_messages WHERE ${MESSAGE_KEY} AND state = ? AND attempt_id = ?`,
        )
        .run(...messageKeyOf(key), A2ADirectMessageState.InFlight, attemptId);
      return Number(changes) === 1;
    });
  }

  findAllInFlightByExpiresAtBefore(
    now: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    return answerOf(() =>
      this.connection.database
        .prepare(
          `SELECT * FROM a2a_direct_messages WHERE state = ? AND expires_at <= ?
           ORDER BY expires_at LIMIT ?`,
        )
        .all(A2ADirectMessageState.InFlight, now.toISOString(), checkedDirectMessageLimit(limit))
        .map(directMessageOf),
    );
  }

  deleteByCreatedAtBefore(cutoff: Date, limit: number): Promise<readonly A2ADirectMessageRecord[]> {
    return answerOf(() =>
      this.connection.transaction(() => {
        const { database } = this.connection;
        const gone = database
          .prepare(
            `SELECT * FROM a2a_direct_messages WHERE created_at < ? ORDER BY created_at LIMIT ?`,
          )
          .all(cutoff.toISOString(), checkedDirectMessageLimit(limit))
          .map(directMessageOf);
        const remove = database.prepare(`DELETE FROM a2a_direct_messages WHERE ${MESSAGE_KEY}`);
        const unclaim = database.prepare(
          `DELETE FROM a2a_messages WHERE ${MESSAGE_KEY} AND task_id = ?`,
        );
        for (const message of gone) {
          remove.run(...messageKeyOf(message));
          unclaim.run(...messageKeyOf(message), DIRECT_MESSAGE_CLAIM);
        }
        // at most `limit` claims more, of messages that went before (a failed attempt's)
        database
          .prepare(
            `DELETE FROM a2a_messages WHERE rowid IN (SELECT m.rowid FROM a2a_messages m
               WHERE m.task_id = ? AND m.saved_at < ? AND NOT EXISTS (
                 SELECT 1 FROM a2a_direct_messages d WHERE d.tenant_id = m.tenant_id
                   AND d.owner_id = m.owner_id AND d.message_id = m.message_id)
               ORDER BY m.saved_at LIMIT ?)`,
          )
          .run(DIRECT_MESSAGE_CLAIM, cutoff.toISOString(), limit);
        return gone;
      }),
    );
  }

  #message(key: A2ADirectMessageKey): A2ADirectMessageRecord | undefined {
    const row = this.connection.database
      .prepare(`SELECT * FROM a2a_direct_messages WHERE ${MESSAGE_KEY}`)
      .get(...messageKeyOf(key));
    return row === undefined ? undefined : directMessageOf(row);
  }

  #insertClaim(message: NewA2ADirectMessage): void {
    const claim = directMessageClaimOf(message);
    this.connection.database
      .prepare(
        `INSERT INTO a2a_messages (tenant_id, owner_id, message_id, request_hash, task_id, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(...messageKeyOf(claim), claim.requestHash, claim.taskId, claim.savedAt.toISOString());
  }
}

sqliteImplementation(SqliteA2ADirectMessageRepository);
