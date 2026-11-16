/**
 * #1250 — `inTransaction` rolls back only a transaction that is still open: when SQLite itself
 * ended it (a full disk, an I/O error, an interrupt), the work's own error surfaces, never
 * "cannot rollback - no transaction is active".
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inTransaction } from "../../src/rag/sqlite-fts-schema.js";

describe("#1250: inTransaction keeps the work's error", () => {
  it("a transaction the work already ended: the work's error is thrown", () => {
    const db = new DatabaseSync(":memory:");
    const cause = new Error("the work failed");
    const run = (): void => {
      inTransaction(db, () => {
        db.exec("ROLLBACK"); // as SQLite does itself on some errors
        throw cause;
      });
    };
    expect(run).toThrow(cause);
    db.close();
  });

  it("a transaction still open is rolled back", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (x)");
    const run = (): void => {
      inTransaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      });
    };
    expect(run).toThrow("boom");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close();
  });
});
