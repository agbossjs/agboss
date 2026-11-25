/**
 * #1317c, review of 502ad948a: a lock wait retries an operation from a clean transaction, and no
 * SQLite path of the core fails fast under another process's lock.
 */
import { readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StoreOutcomeUnknownError } from "../../../src/infrastructure/store-call-timeout.js";
import { CleanAttempt } from "../../../src/infrastructure/sqlite/sqlite-attempt.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { whileBusy } from "../../../src/infrastructure/sqlite/sqlite-lock-wait.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { storeClockOf } from "../../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { unservedStatementsOf } from "./served-scan.js";

const pause = (length: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, length));

/** Two connections to one file that share no mutex (as two processes share none). */
function twoProcesses() {
  const path = temporarySqlitePath();
  const alias = join(dirname(path), "alias");
  symlinkSync(dirname(path), alias);
  return { holder: connectionTo(path), waiter: connectionTo(join(alias, "application.sqlite")) };
}

describe("#1317c: a lock-wait retry starts from a clean transaction", () => {
  it("an operation of two writes that meets another process's lock waits, then writes each row once", async () => {
    const { holder, waiter } = twoProcesses();
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    holder.database.exec("BEGIN IMMEDIATE");
    let tries = 0;

    const waiting = waiter.gate(() => {
      tries += 1;
      waiter.database.prepare("INSERT INTO rows VALUES ('first')").run();
      waiter.database.prepare("INSERT INTO rows VALUES ('second')").run();
      return "done";
    });
    await pause(80);
    // nothing of the operation is on the file while it waits
    expect(holder.database.prepare("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 0 });
    holder.database.exec("COMMIT");

    await expect(Promise.resolve(waiting)).resolves.toBe("done");
    expect(tries).toBeGreaterThan(1);
    expect(holder.database.prepare("SELECT row FROM rows ORDER BY rowid").all()).toEqual([
      { row: "first" },
      { row: "second" },
    ]);
  });

  it("the writes of one operation are one transaction: the lock is taken before the first, so a second connection cannot slip between them", async () => {
    const { holder, waiter } = twoProcesses();
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    let between: unknown;

    await waiter.gate(() => {
      waiter.database.prepare("INSERT INTO rows VALUES ('first')").run();
      try {
        holder.database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        between = error;
      }
      waiter.database.prepare("INSERT INTO rows VALUES ('second')").run();
    });

    expect(String(between)).toMatch(/locked/);
    expect(holder.database.prepare("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 2 });
  });

  it("an operation that fails rolls back everything it wrote", () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");

    expect(() =>
      connection.gate(() => {
        connection.database.prepare("INSERT INTO rows VALUES ('first')").run();
        throw new Error("second write failed");
      }),
    ).toThrow("second write failed");

    expect(connection.database.prepare("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 0 });
  });

  it("connection.transaction inside an operation is part of its transaction (a savepoint of it)", async () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");

    await connection.gate(() => {
      connection.database.prepare("INSERT INTO rows VALUES ('before')").run();
      expect(() =>
        connection.transaction(() => {
          connection.database.prepare("INSERT INTO rows VALUES ('inner')").run();
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
      connection.transaction(() => {
        connection.database.prepare("INSERT INTO rows VALUES ('after')").run();
      });
    });

    expect(connection.database.prepare("SELECT row FROM rows ORDER BY rowid").all()).toEqual([
      { row: "before" },
      { row: "after" },
    ]);
  });

  it("two transaction() calls of one operation are one transaction: a lock met at the first is met before any write", async () => {
    const { holder, waiter } = twoProcesses();
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    holder.database.exec("BEGIN IMMEDIATE");

    const waiting = waiter.gate(() => {
      waiter.transaction(() => waiter.database.prepare("INSERT INTO rows VALUES ('a')").run());
      waiter.transaction(() => waiter.database.prepare("INSERT INTO rows VALUES ('b')").run());
    });
    await pause(60);
    holder.database.exec("COMMIT");
    await waiting;

    expect(holder.database.prepare("SELECT row FROM rows ORDER BY rowid").all()).toEqual([
      { row: "a" },
      { row: "b" },
    ]);
  });
});

describe("#1317c: the guard — a busy answer after rows changed is never retried", () => {
  it("total_changes moved before the busy answer: StoreOutcomeUnknownError, the call is not run again", async () => {
    const path = temporarySqlitePath();
    const alias = join(dirname(path), "alias");
    symlinkSync(dirname(path), alias);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE rows (row TEXT)");
    const other = new DatabaseSync(join(alias, "application.sqlite"));
    other.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA busy_timeout = 0");
    const attempt = new CleanAttempt(database);
    let tries = 0;

    // a write path that skipped the attempt (an autocommit statement, then the lock lost to another)
    const failed = await Promise.resolve()
      .then(async () => {
        await whileBusy(database, () => {
          attempt.run(() => {
            tries += 1;
            database.prepare("INSERT INTO rows VALUES ('first')").run();
            other.exec("BEGIN IMMEDIATE");
            try {
              database.prepare("INSERT INTO rows VALUES ('second')").run();
            } finally {
              other.exec("ROLLBACK");
            }
          });
        });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failed).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(tries).toBe(1);
    expect(database.prepare("SELECT row FROM rows").all()).toEqual([{ row: "first" }]);
    database.close();
    other.close();
  });
});

describe("#1317c: no SQLite path of the core fails fast under another process's lock", () => {
  it("the cluster mirror's operations (inherited by the lease store) wait for the lock", async () => {
    const { holder, waiter } = twoProcesses();
    const clock = new VirtualClock();
    const leases = new SqliteExecutionLeaseRepository(
      waiter,
      storeClockOf(clock),
      applicationContextOf({
        name: "lock-wait",
        version: "1.0.0",
        instanceId: "instance-b",
        startedAt: clock.now(),
        environmentName: "test",
        environment: NO_ENVIRONMENT_VALUES,
      }),
    );
    const lease = {
      tenantId: "default",
      rootExecutionId: "execution-1",
      holderInstanceId: "instance-b",
      token: 1,
      expiresAt: new Date(60_000),
      remaining: 30_000,
    };
    holder.database.exec("BEGIN IMMEDIATE");

    const synced = leases.syncClusterLease(lease as never);
    await pause(60);
    holder.database.exec("COMMIT");

    await expect(synced).resolves.toMatchObject({ outcome: expect.any(String) });
    await expect(leases.mirroredLeaseOf(lease)).resolves.toMatchObject({ token: 1 });
  });

  it("the checkpoint saver's transactions wait for the lock", async () => {
    const { holder, waiter } = twoProcesses();
    const saver = new SqliteCheckpointSaver(waiter);
    holder.database.exec("BEGIN IMMEDIATE");

    const cleared = saver.deleteThread("thread-1");
    await pause(60);
    holder.database.exec("COMMIT");

    await expect(cleared).resolves.toBeUndefined();
  });
});

/** Every source file under `folder`, as paths relative to `root`. */
function sourcesUnder(folder: string, root = folder): string[] {
  return readdirSync(folder).flatMap((entry) => {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) return sourcesUnder(path, root);
    return path.endsWith(".ts") ? [relative(root, path)] : [];
  });
}

const SRC = join(__dirname, "..", "..", "..", "src");

/** A statement or transaction on a `SqliteConnection`, or a `DatabaseSync` of a file's own. */
const DIRECT =
  /\bconnection\.(?:database|transaction)\b|\bDatabaseSync\b|\bdatabase\.(?:exec|prepare)\(/;

const sourceOf = (file: string): string => readFileSync(join(SRC, file), "utf8");

/**
 * The review's guard (#1317c): with `busy_timeout = 0` a statement outside the gate fails at once
 * under another process's lock. A file of `src` outside `infrastructure/sqlite` that touches a
 * database is listed here with its reason; a new one fails the test until it is reviewed.
 */
const OUTSIDE_THE_GATE: Readonly<Record<string, string>> = {
  "infrastructure/live-lease.ts":
    "a helper taking the database; its caller is a gated outbound-call store operation",
  "rag/sqlite-fts-schema.ts":
    "the RAG index is its own file with its own DatabaseSync and busy timeout, not the application's connection",
  "rag/sqlite-fts-write.ts": "the RAG index's own file (see sqlite-fts-schema)",
  "rag/sqlite-fts.ts": "the RAG index's own file (see sqlite-fts-schema)",
  "turns/configs.ts":
    "the turns store is its own file with its own DatabaseSync, not the application's connection",
  "turns/idle-threads.ts": "the turns store's own file (see turns/configs)",
  "turns/schema.ts": "the turns store's own file (see turns/configs)",
  "turns/sqlite-store.ts": "the turns store's own file (see turns/configs)",
  "turns/status-log.ts": "the turns store's own file (see turns/configs)",
  "turns/summaries.ts": "the turns store's own file (see turns/configs)",
  "turns/threads.ts": "the turns store's own file (see turns/configs)",
  "turns/writes.ts": "the turns store's own file (see turns/configs)",
};

/** Classes of `infrastructure/sqlite` that use their connection and are not registered themselves. */
const REACHED_THROUGH_A_GATED_CLASS: Readonly<Record<string, string>> = {
  "infrastructure/sqlite/sqlite-pause-store.ts":
    "held by SqlitePausedExecutionRepository, whose every operation is gated",
  "infrastructure/sqlite/sqlite-paused-runs.repository.ts":
    "base of SqlitePauseStore (see sqlite-pause-store)",
  "infrastructure/sqlite/sqlite-pause-queries.repository.ts":
    "base of SqlitePauseStore (see sqlite-pause-store)",
  "infrastructure/sqlite/sqlite-connection.ts":
    "the connection: the gate itself, and the startup schema work on its startup busy_timeout",
  "infrastructure/sqlite/sqlite-guard.ts": "the statement guard of the connection",
  "infrastructure/sqlite/sqlite-attempt.ts": "the gate's clean attempt",
  "infrastructure/sqlite/sqlite-hold.ts": "the hold: its BEGIN IMMEDIATE waits through whileBusy",
  "infrastructure/sqlite/sqlite-mutex.ts": "the file's mutex",
  "infrastructure/sqlite/sqlite-lock-wait.ts": "the wait itself",
  "infrastructure/sqlite/sqlite-transaction.ts":
    "the hold's handle: statements of the open transaction",
  "infrastructure/sqlite/sqlite-open.ts":
    "synchronous open: SQLite's own wait on the startup busy_timeout",
  "infrastructure/sqlite/sqlite-baseline-schema.ts":
    "synchronous start-up schema work, on the startup busy_timeout",
  "infrastructure/sqlite/sqlite-schema-version.ts":
    "synchronous start-up check, on the startup busy_timeout",
  "infrastructure/sqlite/sqlite-outcome.ts":
    "classifies the outcome of statements; runs none of its own",
};

describe("#1317c: a new direct SQLite caller cannot appear unreviewed", () => {
  const files = sourcesUnder(SRC);

  it("outside infrastructure/sqlite only the listed files touch a database, each with its reason", () => {
    const touching = files
      .filter((file) => !file.startsWith("infrastructure/sqlite/"))
      .filter((file) => DIRECT.test(sourceOf(file)))
      .sort();

    expect(touching).toEqual(Object.keys(OUTSIDE_THE_GATE).sort());
  });

  it("every class of infrastructure/sqlite that uses its connection is registered with sqliteImplementation, or is reached through one that is", () => {
    const ungated = files
      .filter((file) => file.startsWith("infrastructure/sqlite/"))
      .filter((file) => /\bclass\s+\w+/.test(sourceOf(file)))
      .filter((file) =>
        /this\.connection\b|connection\.(?:database|transaction)\b/.test(sourceOf(file)),
      )
      .filter((file) => !/\bsqliteImplementation\(/.test(sourceOf(file)))
      .sort();

    expect(ungated.filter((file) => !(file in REACHED_THROUGH_A_GATED_CLASS))).toEqual([]);
  });

  it("the listed files still exist and still touch a database (a stale entry is removed)", () => {
    for (const file of [...Object.keys(OUTSIDE_THE_GATE)])
      expect(DIRECT.test(sourceOf(file))).toBe(true);
  });
});

/** The gate itself: its statements are the queue's, the hold's and the attempt's own. */
const THE_GATE = new Set(
  [
    "sqlite-attempt.ts",
    "sqlite-gate.ts",
    "sqlite-guard.ts",
    "sqlite-hold.ts",
    "sqlite-lock-wait.ts",
    "sqlite-mutex.ts",
    "sqlite-served.ts",
  ].map((name) => `infrastructure/sqlite/${name}`),
);

describe("#1317: no statement of a SQLite operation runs after an await outside connection.serve", () => {
  const files = sourcesUnder(SRC);

  it("every file on the application's connection serves each group of statements after an await", () => {
    // the turn store runs on the application's connection too (sharedTurnStore), as does live-lease
    const scanned = files.filter(
      (file) =>
        (file.startsWith("infrastructure/sqlite/") && !THE_GATE.has(file)) ||
        file.startsWith("turns/") ||
        file === "infrastructure/live-lease.ts",
    );
    const unserved = scanned.flatMap((file) =>
      unservedStatementsOf(sourceOf(file)).map((found) => `${file}:${found}`),
    );

    expect(scanned.length).toBeGreaterThan(40);
    expect(unserved).toEqual([]);
  });

  it("the scan bites: the shapes the bug hunt found are each reported", () => {
    const shapes = [
      // the outbound call's markCompleted before #1317: a member that opens a transaction, after an await
      `class A { #fenced() { return this.connection.transaction(() => 1); }
        async mark() { const { endedOf } = await this.changes; return this.#fenced(); } }`,
      // the checkpoint saver's put: the serde awaited, then the transaction
      `class B { async put() { await this.serde.dumpsTyped(1); this.connection.transaction(() => 1); } }`,
      // a helper handed the connection after an await
      `class C { async claim() { const m = await load(); return m.saved(this.connection, 1); } }`,
      // a loop: its second turn runs after the first turn's await
      `async function sweep(db) { for (const t of ts) { removal.run(t); await isEnded(t); } }`,
      // a stream: the gate never covers its body
      `class D { async *list() { yield this.connection.database.prepare("x").all(); } }`,
    ];

    for (const shape of shapes) expect(unservedStatementsOf(shape), shape).not.toEqual([]);
    expect(
      unservedStatementsOf(
        `class E { async put() { await x(); await this.connection.serve(() => db.prepare("y").run()); } }`,
      ),
    ).toEqual([]);
  });
});
