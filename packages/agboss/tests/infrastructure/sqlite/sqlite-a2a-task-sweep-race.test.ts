/**
 * #960 — the SQLite orphan sweep reads and deletes inside one `BEGIN IMMEDIATE` transaction, so the
 * interleaving that double-charged on MongoDB (a sweep reads an orphan, a second sweep removes it,
 * a resend creates a new task under the same message id, the first sweep deletes what it read)
 * cannot happen: while a sweep holds the write lock, a second instance's resend is refused, not
 * interleaved; once it ends the resend is a new task, and the next resend is a duplicate.
 */
import { describe, expect, it } from "vitest";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type NewA2ATask,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { SqliteA2ATaskRepository } from "../../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { sweepSqliteA2ATasks } from "../../../src/infrastructure/sqlite/sqlite-a2a-task-sweep.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

const newTask = (taskId: string, messageId: string, acceptedAt: Date): NewA2ATask => ({
  tenantId: "default",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "s",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt,
  messageId,
  requestHash: "h-1",
});

describe("#960: the SQLite orphan sweep against a resend of the orphan's message id", () => {
  it("a resend cannot interleave with a sweep; the new task's message is never swept after it", async () => {
    const path = temporarySqlitePath();
    const sweeper = connectionTo(path);
    const other = connectionTo(path);
    // the other instance answers a busy lock at once, so the interleaving shows as a refusal
    other.database.exec("PRAGMA busy_timeout = 0");
    const tasks = new SqliteA2ATaskRepository(other);
    const message = {
      tenantId: "default",
      ownerId: "alice",
      messageId: "m-x",
      requestHash: "h-1",
      taskId: "t-gone",
      savedAt: at(1),
    };
    await tasks.saveMessageIfAbsent(message);

    let interleaved: Promise<unknown> = Promise.resolve();
    sweeper.transaction(() => {
      // the sweep has the write lock: the resend would be a new task under the orphan's message id
      interleaved = tasks.saveIfAbsent(newTask("t-20", "m-x", at(20))).then(
        () => "saved",
        () => "refused",
      );
      sweepSqliteA2ATasks(sweeper.database, at(10));
    });

    expect(await interleaved).toBe("refused");
    expect(await tasks.findByMessage(message)).toBeUndefined();
    expect((await tasks.saveIfAbsent(newTask("t-20", "m-x", at(20)))).status).toBe(
      A2ATaskSaveStatus.Saved,
    );
    // a later sweep leaves the live task's message; its resend is a duplicate
    sweeper.transaction(() => {
      sweepSqliteA2ATasks(sweeper.database, at(10));
    });
    expect((await tasks.saveIfAbsent(newTask("t-30", "m-x", at(21)))).status).toBe(
      A2ATaskSaveStatus.MessageTaken,
    );
  });
});
