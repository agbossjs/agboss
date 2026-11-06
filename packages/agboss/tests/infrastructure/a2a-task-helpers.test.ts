/**
 * #807 — the A2A task stores' helpers on their own: the page token's refusal, a saved task's shape,
 * the sweep's expiry, the stores' `ping()` and the SQLite store's registration.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { a2aPagePositionOf, nextPageTokenOf } from "../../src/infrastructure/a2a-task-pages.js";
import {
  A2ATaskRepository,
  A2ATaskState,
  a2aTaskExpiryOf,
  InvalidA2APageTokenError,
  savedA2ATaskOf,
  type A2ATaskRecord,
} from "../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { isSqliteImplementation } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { hours } from "../../src/units/index.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const accepted = {
  tenantId: "default",
  taskId: "t-1",
  ownerId: undefined,
  contextId: "ctx-1",
  skill: "s",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: "m-1",
  requestHash: "h",
};

describe("#807: the A2A task stores' helpers", () => {
  it("a refused page token is a2a.invalid-page-token, naming no token", () => {
    const error = new InvalidA2APageTokenError();

    expect(error.code).toBe("a2a.invalid-page-token");
    expect(error.message).toBe("the page token is not one a list of these tasks gave");
    expect(() => a2aPagePositionOf("")).toThrow(InvalidA2APageTokenError);
  });

  it("a token beyond what a date holds is refused, at the edge accepted (L3)", () => {
    const token = (at: number) => Buffer.from(JSON.stringify([at, "t"])).toString("base64url");

    expect(a2aPagePositionOf(token(8.64e15))).toEqual({ statusAt: 8.64e15, taskId: "t" });
    expect(a2aPagePositionOf(token(-8.64e15)).statusAt).toBe(-8.64e15);
    expect(() => a2aPagePositionOf(token(8.64e15 + 1))).toThrow(InvalidA2APageTokenError);
    expect(() => a2aPagePositionOf(token(1.5))).toThrow(InvalidA2APageTokenError);
  });

  it("a page with more after it has a token; one with none, the empty text", () => {
    const task = { statusAt: NINE, taskId: "t-1" } as A2ATaskRecord;

    expect(nextPageTokenOf([task], false)).toBe("");
    expect(a2aPagePositionOf(nextPageTokenOf([task], true))).toEqual({
      statusAt: NINE.getTime(),
      taskId: "t-1",
    });
    expect(() => nextPageTokenOf([], true)).toThrow(/a page with more after it is not empty/u);
  });

  it("a saved task has no caller peer key unless it was given one", () => {
    expect(Object.keys(savedA2ATaskOf(accepted))).not.toContain("callerPeer");
    expect(savedA2ATaskOf({ ...accepted, callerPeer: "p" }).callerPeer).toBe("p");
  });

  it("the sweep's expiry names the finished tasks and removes them by their status time", async () => {
    const asked: Date[] = [];
    const tasks = {
      deleteTerminalByStatusAtBefore: (cutoff: Date) => {
        asked.push(cutoff);
        return Promise.resolve();
      },
    };

    const expiry = a2aTaskExpiryOf(tasks, hours(24));
    await expiry.remove?.(NINE);

    expect(expiry).toMatchObject({ what: "the finished A2A tasks", retention: hours(24) });
    expect(asked).toEqual([NINE]);
  });

  it("#824: each store declares its backend; the contract leaves it undeclared", () => {
    expect([
      A2ATaskRepository.backend,
      InMemoryA2ATaskRepository.backend,
      SqliteA2ATaskRepository.backend,
    ]).toEqual([undefined, "in-memory", "sqlite"]);
  });

  it("both stores answer ping() with a promise; the SQLite one is a SQLite implementation", async () => {
    const memory = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    const database = new DatabaseSync(":memory:");
    const connection = {
      database,
      ensureSchema: (_name: string, ddl: string) => {
        database.exec(ddl);
      },
      ping: () => Promise.resolve(),
      transaction: <T>(work: () => T): T => work(),
    };
    const sqlite = new SqliteA2ATaskRepository(connection as never);

    expect(memory.ping()).toBeInstanceOf(Promise);
    expect(sqlite.ping()).toBeInstanceOf(Promise);
    await expect(memory.ping()).resolves.toBeUndefined();
    expect(isSqliteImplementation(sqlite)).toBe(true);
    database.close();
  });

  it("a SQLite row whose state column and status disagree is refused, never read (M6)", async () => {
    const database = new DatabaseSync(":memory:");
    const connection = {
      database,
      ensureSchema: (_name: string, ddl: string) => {
        database.exec(ddl);
      },
      transaction: <T>(work: () => T): T => work(),
    };
    const sqlite = new SqliteA2ATaskRepository(connection as never);
    await sqlite.saveIfAbsent(accepted);
    database.prepare("UPDATE a2a_tasks SET state = 'TASK_STATE_COMPLETED'").run();

    await expect(sqlite.findById({ tenantId: "default", taskId: "t-1" })).rejects.toThrow(
      "a2a_tasks row t-1: its state column and its status disagree",
    );
    database.close();
  });
});
