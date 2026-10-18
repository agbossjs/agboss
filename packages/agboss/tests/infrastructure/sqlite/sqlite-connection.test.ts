/**
 * #265 S32: the connection of an application instance — WAL and `busy_timeout` on the file, atomic
 * operations in `BEGIN IMMEDIATE` (a second connection waits for the writer, then sees its rows; a
 * busy file fails after the timeout instead of hanging), a failed transaction rolled back. And the
 * regression: no SQL reads SQLite's own clock — every time value comes from the framework's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inImmediateTransaction,
  openSqliteDatabase,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const SQLITE_SOURCES = new URL("../../../src/infrastructure/sqlite/", import.meta.url);

describe("#265 S32: one connection per instance on sqlitePath", () => {
  it("the file is in WAL mode with a busy timeout", () => {
    const connection = connectionTo(temporarySqlitePath());

    const mode = connection.database.prepare("PRAGMA journal_mode").get();
    const timeout = connection.database.prepare("PRAGMA busy_timeout").get();

    expect(mode).toEqual({ journal_mode: "wal" });
    expect(timeout).toEqual({ timeout: 5000 });
  });

  it("BEGIN IMMEDIATE between connections: a busy file fails after the timeout, then the rows are seen", () => {
    const path = temporarySqlitePath();
    const writer = connectionTo(path);
    writer.ensureSchema("notes", "CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL);");
    const impatient = openSqliteDatabase(path, 50);

    writer.database.exec("BEGIN IMMEDIATE");
    writer.database.prepare("INSERT INTO notes VALUES (?)").run("first");
    const whileWriting = (): void => {
      inImmediateTransaction(impatient, () => {
        impatient.exec("INSERT INTO notes VALUES ('x')");
      });
    };
    expect(whileWriting).toThrow(/locked|busy/i);
    writer.database.exec("COMMIT");
    const rows = impatient.prepare("SELECT text FROM notes").all();
    impatient.close();

    expect(rows).toEqual([{ text: "first" }]);
  });

  it("a transaction that throws is rolled back", () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.ensureSchema("notes", "CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL);");

    expect(() =>
      connection.transaction(() => {
        connection.database.prepare("INSERT INTO notes VALUES (?)").run("lost");
        throw new Error("the work failed");
      }),
    ).toThrow("the work failed");
    expect(connection.database.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 0 });
    expect(connection.database.isTransaction).toBe(false);
  });

  it("an in-memory path keeps the database in the connection; closing twice is harmless", () => {
    const connection = connectionTo(":memory:");

    connection.onDestroy();

    expect(connection.path).toBe(":memory:");
    expect(() => {
      connection.onDestroy();
    }).not.toThrow();
  });
});

describe("#265 S32 regression: time only from the framework's clock", () => {
  it("no SQL of a SQLite implementation reads SQLite's clock", () => {
    const sources = readdirSync(SQLITE_SOURCES).filter((name) => name.endsWith(".ts"));
    const clockReads = sources.filter((name) =>
      /CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|unixepoch\(|datetime\(|julianday\(|'now'/i.test(
        readFileSync(join(SQLITE_SOURCES.pathname, name), "utf8"),
      ),
    );

    expect(sources.length).toBeGreaterThan(5);
    expect(clockReads).toEqual([]);
  });
});
