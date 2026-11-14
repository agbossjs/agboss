/**
 * #1017 — which errors of SQLite leave a write's outcome unknown. A synchronous, in-process store
 * has one window: the COMMIT (or the implicit one of a single statement). An error of the COMMIT
 * statement itself — a failed sync, an I/O error, any code that does not say "still open" — may
 * have left the transaction applied or not, so it is `StoreOutcomeUnknownError`. BUSY and
 * CONSTRAINT at COMMIT leave the transaction open (it is rolled back: not applied) and a failure
 * before the COMMIT is rolled back: both stay ordinary errors. Reads never are.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../../../src/index.js";
import { inImmediateTransaction } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { classifiedDatabase } from "../../../src/infrastructure/sqlite/sqlite-outcome.js";

/** The error node:sqlite throws for a result code. */
const failure = (errcode: number, errstr: string): Error =>
  Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });

const IOERR_FSYNC = 1034;
const SQLITE_FULL = 13;
const SQLITE_BUSY = 5;
const BUSY_SNAPSHOT = 517;

/** A database whose COMMIT fails with `error` (after it ran `work`'s statements); `rows` read back. */
function database(): DatabaseSync {
  const opened = new DatabaseSync(":memory:");
  opened.exec("CREATE TABLE notes (text TEXT NOT NULL)");
  return opened;
}

function failingCommit(opened: DatabaseSync, error: Error): void {
  const exec = opened.exec.bind(opened);
  vi.spyOn(opened, "exec").mockImplementation((sql: string) => {
    if (sql === "COMMIT") throw error;
    exec(sql);
  });
}

const rowsOf = (opened: DatabaseSync): number =>
  Number(opened.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n);

const write =
  (opened: DatabaseSync, run: () => void = () => undefined) =>
  (): void => {
    opened.prepare("INSERT INTO notes VALUES ('a')").run();
    run();
  };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1017: a COMMIT that failed", () => {
  it.each([
    ["SQLITE_IOERR_FSYNC", IOERR_FSYNC, "disk I/O error"],
    ["SQLITE_FULL", SQLITE_FULL, "database or disk is full"],
    ["SQLITE_NOMEM", 7, "out of memory"],
    ["SQLITE_INTERRUPT", 9, "interrupted"],
    ["SQLITE_PROTOCOL", 15, "locking protocol"],
  ])(
    "%s: unknown (Transport), the transaction rolled back as far as it can be",
    (_name, code, text) => {
      const opened = database();
      const cause = failure(code, text);
      failingCommit(opened, cause);

      let error: unknown;
      try {
        inImmediateTransaction(opened, write(opened));
      } catch (thrown) {
        error = thrown;
      }

      expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(error).toMatchObject({
        store: "SqliteConnection",
        operation: "COMMIT",
        source: StoreOutcomeSource.Transport,
        cause,
      });
      expect(opened.isTransaction).toBe(false);
    },
  );

  it.each([
    ["SQLITE_BUSY", SQLITE_BUSY],
    ["SQLITE_BUSY_SNAPSHOT", BUSY_SNAPSHOT],
  ])(
    "%s: the transaction stays open and is rolled back — an ordinary error, nothing written",
    (_name, code) => {
      const opened = database();
      const cause = failure(code, "database is locked");
      failingCommit(opened, cause);

      expect(() => {
        inImmediateTransaction(opened, write(opened));
      }).toThrow(cause);
      expect(opened.isTransaction).toBe(false);
      expect(rowsOf(opened)).toBe(0);
    },
  );

  it("a deferred foreign key refused at COMMIT (the real one): an ordinary error, nothing written", () => {
    const opened = database();
    opened.exec("PRAGMA foreign_keys = ON");
    opened.exec("CREATE TABLE owners (id INTEGER PRIMARY KEY)");
    opened.exec(
      "CREATE TABLE pets (owner INTEGER REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED)",
    );

    let error: unknown;
    try {
      inImmediateTransaction(opened, () => {
        opened.exec("INSERT INTO pets VALUES (5)");
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
    expect(opened.isTransaction).toBe(false);
  });

  it("an error of the work, before the COMMIT, is rolled back and rethrown as it is — even an I/O error", () => {
    const opened = database();
    const io = failure(IOERR_FSYNC, "disk I/O error");

    const failingWork = write(opened, () => {
      throw io;
    });

    expect(() => {
      inImmediateTransaction(opened, failingWork);
    }).toThrow(io);
    expect(rowsOf(opened)).toBe(0);
  });
});

describe("#1017: a single write outside a transaction", () => {
  /** A classified database whose next `INSERT` fails with `error`. */
  function insertFailing(error: Error): () => unknown {
    const opened = database();
    const statement = opened.prepare("INSERT INTO notes VALUES ('a')");
    vi.spyOn(statement, "run").mockImplementation(() => {
      throw error;
    });
    vi.spyOn(opened, "prepare").mockReturnValue(statement);
    const classified = classifiedDatabase(opened);
    return () => classified.prepare("INSERT INTO notes VALUES ('a')").run();
  }

  it("an I/O error of the implicit commit is unknown", () => {
    const cause = failure(IOERR_FSYNC, "disk I/O error");

    expect(insertFailing(cause)).toThrow(StoreOutcomeUnknownError);
    expect(insertFailing(cause)).toThrow(expect.objectContaining({ cause }));
  });

  it("a code that guarantees nothing was applied is the store's own answer: an ordinary error", () => {
    for (const code of [SQLITE_BUSY, 19]) {
      const cause = failure(code, "refused");
      expect(insertFailing(cause)).toThrow(cause);
    }
  });

  it("an error inside a transaction is the transaction's: the COMMIT decides", () => {
    const opened = database();
    const cause = failure(IOERR_FSYNC, "disk I/O error");
    const classified = classifiedDatabase(opened);
    classified.exec("BEGIN IMMEDIATE");
    const statement = classified.prepare("INSERT INTO notes VALUES ('a')");
    vi.spyOn(statement, "run").mockImplementation(() => {
      throw cause;
    });

    expect(() => statement.run()).toThrow(cause);
    classified.exec("ROLLBACK");
  });

  it("a read is never unknown, and the classified database is the database", () => {
    const opened = database();
    const classified = classifiedDatabase(opened);
    classified.exec("INSERT INTO notes VALUES ('a')");

    expect(classified.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });
    expect(classified.isOpen).toBe(true);
    expect(classified.isTransaction).toBe(false);
  });
});
