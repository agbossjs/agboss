/**
 * #700 — an index file written before tenants (version 0: one `chunks` and one `files` table for
 * everyone) is migrated in place on first open: its chunks become the default tenant's, nothing is
 * indexed again, another tenant starts empty; a file of a later version is refused, never rewritten.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteFtsConnector } from "../../src/rag/sqlite-fts.js";
import { RagIndexVersionError } from "../../src/rag/sqlite-fts-schema.js";

const signal = new AbortController().signal;

/** A folder with one document and an index file as the connector wrote it before #700. */
async function version0(): Promise<{ folder: string; sqlitePath: string }> {
  const folder = await mkdtemp(join(tmpdir(), "fts-v0-"));
  await writeFile(join(folder, "leave.md"), "Leave is twenty five days a year.");
  const sqlitePath = join(folder, "fts.sqlite");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`CREATE VIRTUAL TABLE chunks USING fts5(source, text);
    CREATE TABLE files (source TEXT PRIMARY KEY, hash TEXT NOT NULL);`);
  db.prepare("INSERT INTO chunks VALUES (?, ?)").run("leave.md", "Leave from the old index.");
  // the hash of the file as it is: the migrated mark keeps it unchanged
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("Leave is twenty five days a year.").digest("hex");
  db.prepare("INSERT INTO files VALUES (?, ?)").run("leave.md", hash);
  db.close();
  return { folder, sqlitePath };
}

describe("#700: SqliteFtsConnector migrates an index of before tenants", () => {
  it("its chunks are the default tenant's, kept as they were; another tenant starts empty", async () => {
    const { folder, sqlitePath } = await version0();
    const connector = new SqliteFtsConnector({ folder, sqlitePath });

    const asDefault = await connector.retrieve("leave", { topK: 5, tenantId: "default", signal });
    const report = await connector.index({ tenantId: "default", signal });

    expect(asDefault.results.map((r) => r.text)).toEqual(["Leave from the old index."]);
    expect(report).toMatchObject({ documents: 1, skipped: 1 });
    const db = new DatabaseSync(sqlitePath);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v0'").all();
    expect(tables).toEqual([]);
    db.close();
  });

  it("another tenant's first retrieval indexes its own copy of a shared folder", async () => {
    const { folder, sqlitePath } = await version0();
    const connector = new SqliteFtsConnector({ folder, sqlitePath });

    const other = await connector.retrieve("leave", { topK: 5, tenantId: "acme", signal });

    expect(other.results.map((r) => r.text)).toEqual(["Leave is twenty five days a year."]);
  });

  it("a file of a later version is refused (rag.index-version) and left as it is", async () => {
    const folder = await mkdtemp(join(tmpdir(), "fts-v9-"));
    const sqlitePath = join(folder, "fts.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec("PRAGMA user_version = 9");
    db.close();
    const connector = new SqliteFtsConnector({ folder, sqlitePath });

    const refused = await connector
      .retrieve("x", { topK: 1, tenantId: "default", signal })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(RagIndexVersionError);
    expect(refused).toMatchObject({ code: "rag.index-version" });
    const after = new DatabaseSync(sqlitePath);
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    after.close();
  });
});
