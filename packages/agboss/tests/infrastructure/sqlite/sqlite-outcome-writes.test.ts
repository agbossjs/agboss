/**
 * #1017 — a single write outside a transaction commits implicitly, through the same WAL commit
 * phase as COMMIT, so it is classified by the same rule, by WHITELIST: known only for the codes
 * that guarantee nothing was applied before the commit phase, every other code is unknown. The
 * write is recognised from its prepared SQL and classified whichever method runs it — `run`,
 * `get` or `all` (an `UPDATE … RETURNING` is read through `get`/`all`) — and a read never is.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../../../src/index.js";
import { classifiedDatabase } from "../../../src/infrastructure/sqlite/sqlite-outcome.js";

const failure = (errcode: number, errstr: string): Error =>
  Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });

type Method = "run" | "get" | "all";
const METHODS: readonly Method[] = ["run", "get", "all"];

/** Codes that may leave the write applied (or cannot tell): unknown. */
const UNKNOWN_CODES: readonly (readonly [string, number])[] = [
  ["SQLITE_IOERR", 10],
  ["SQLITE_IOERR_FSYNC", 1034],
  ["SQLITE_FULL", 13],
  ["SQLITE_NOMEM", 7],
  ["SQLITE_INTERRUPT", 9],
  ["SQLITE_PROTOCOL", 15],
  ["SQLITE_ERROR", 1],
  ["SQLITE_CORRUPT", 11],
  ["SQLITE_CANTOPEN", 14],
  ["SQLITE_ABORT", 4],
];

/** Codes that guarantee nothing was applied: the statement's own refusal. */
const KNOWN_CODES: readonly (readonly [string, number])[] = [
  ["SQLITE_BUSY", 5],
  ["SQLITE_BUSY_SNAPSHOT", 517],
  ["SQLITE_LOCKED", 6],
  ["SQLITE_READONLY", 8],
  ["SQLITE_TOOBIG", 18],
  ["SQLITE_CONSTRAINT", 19],
  ["SQLITE_CONSTRAINT_UNIQUE", 2067],
  ["SQLITE_MISMATCH", 20],
  ["SQLITE_MISUSE", 21],
  ["SQLITE_AUTH", 23],
  ["SQLITE_RANGE", 25],
];

const WRITES = [
  "INSERT INTO notes VALUES ('a')",
  "UPDATE notes SET text = 'b' RETURNING text",
  "DELETE FROM notes",
  "REPLACE INTO notes VALUES ('a')",
  "WITH gone AS (SELECT 1) DELETE FROM notes",
];
const READS = [
  "SELECT text FROM notes",
  "SELECT replace(text, 'a', 'b') FROM notes",
  "SELECT 'update' AS verb FROM notes",
  "WITH one AS (SELECT 1 AS n) SELECT n FROM one",
  "SELECT text FROM notes -- delete everything",
];

/** `call` of `method` on a classified statement of `sql` that fails with `error` (not in a transaction). */
function failing(
  sql: string,
  method: Method,
  error: Error,
  isInTransaction = false,
): () => unknown {
  const opened = new DatabaseSync(":memory:");
  opened.exec("CREATE TABLE notes (text TEXT NOT NULL)");
  const statement = opened.prepare("SELECT 1"); // stands in: the classifier reads the SQL it was given
  vi.spyOn(statement, method).mockImplementation(() => {
    throw error;
  });
  vi.spyOn(opened, "prepare").mockReturnValue(statement);
  const classified = classifiedDatabase(opened);
  if (isInTransaction) opened.exec("BEGIN IMMEDIATE");
  return () => classified.prepare(sql)[method]();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1017: an autocommit write is classified by whitelist, whichever method runs it", () => {
  it.each(
    UNKNOWN_CODES.flatMap(([name, code]) =>
      METHODS.map((method): [string, number, Method] => [name, code, method]),
    ),
  )("%s through %s: unknown (Transport), the error is the cause", (_name, code, method) => {
    const cause = failure(code, "refused");
    const call = failing(WRITES[1] ?? "", method, cause);

    expect(call).toThrow(StoreOutcomeUnknownError);
    expect(call).toThrow(
      expect.objectContaining({
        store: "SqliteConnection",
        operation: "write",
        source: StoreOutcomeSource.Transport,
        cause,
      }),
    );
  });

  it.each(
    KNOWN_CODES.flatMap(([name, code]) =>
      METHODS.map((method): [string, number, Method] => [name, code, method]),
    ),
  )("%s through %s: the statement's own refusal, an ordinary error", (_name, code, method) => {
    const cause = failure(code, "refused");

    expect(failing(WRITES[1] ?? "", method, cause)).toThrow(cause);
  });

  it.each(WRITES)("recognised as a write: %s", (sql) => {
    expect(failing(sql, "get", failure(13, "database or disk is full"))).toThrow(
      StoreOutcomeUnknownError,
    );
  });

  it("an unrecognised error (not SQLite's, no code) is unknown too: nothing says it was applied or not", () => {
    expect(failing(WRITES[0] ?? "", "run", new Error("boom"))).toThrow(StoreOutcomeUnknownError);
  });

  it.each(READS.flatMap((sql) => METHODS.map((method): [string, Method] => [sql, method])))(
    "a read is unaffected: %s through %s",
    (sql, method) => {
      const cause = failure(10, "disk I/O error");

      expect(failing(sql, method, cause)).toThrow(cause);
    },
  );

  it("a real UPDATE … RETURNING works through get and all", () => {
    const classified = classifiedDatabase(new DatabaseSync(":memory:"));
    classified.exec("CREATE TABLE notes (text TEXT NOT NULL)");
    classified.exec("INSERT INTO notes VALUES ('a')");

    expect(classified.prepare("UPDATE notes SET text = 'b' RETURNING text").get()).toEqual({
      text: "b",
    });
    expect(classified.prepare("UPDATE notes SET text = 'c' RETURNING text").all()).toEqual([
      { text: "c" },
    ]);
  });

  it.each(METHODS)(
    "inside a transaction an error is the transaction's (%s): the COMMIT decides",
    (method) => {
      const cause = failure(13, "database or disk is full");

      expect(failing(WRITES[1] ?? "", method, cause, true)).toThrow(cause);
    },
  );
});
