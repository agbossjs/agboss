/**
 * An index file of an older version (before scopes: one `chunks` and one `files` table for
 * everyone) is derived data: it is dropped and rebuilt from the documents, never migrated; a file of
 * a later version is refused, never rewritten.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { retrieve, index } from "./access.js";
import { describe, expect, it } from "vitest";
import { SqliteFtsRagSource } from "../../src/rag/sqlite-fts.js";
import { RagIndexVersionError } from "../../src/rag/sqlite-fts-schema.js";

const signal = new AbortController().signal;

/** A folder with one document and an index file as the source wrote it before scopes. */
async function version0(): Promise<{ directory: string; path: string }> {
  const folder = await mkdtemp(join(tmpdir(), "fts-v0-"));
  await writeFile(join(folder, "leave.md"), "Leave is twenty five days a year.");
  const path = join(folder, "fts.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE VIRTUAL TABLE chunks USING fts5(source, text);
    CREATE TABLE files (source TEXT PRIMARY KEY, hash TEXT NOT NULL);`);
  db.prepare("INSERT INTO chunks VALUES (?, ?)").run("leave.md", "Leave from the old index.");
  // the hash of the file as it is: the migrated mark keeps it unchanged
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("Leave is twenty five days a year.").digest("hex");
  db.prepare("INSERT INTO files VALUES (?, ?)").run("leave.md", hash);
  db.close();
  return { directory: folder, path };
}

describe("SqliteFtsRagSource rebuilds an index of an older version", () => {
  it("the old tables are dropped and the documents are indexed again: nothing of the old index is served", async () => {
    const { directory: folder, path } = await version0();
    const connector = new SqliteFtsRagSource({ directory: folder, path });

    const first = await retrieve(connector, "leave", {
      topK: 5,
      tenantId: "default",
      scopeId: "default",
      signal,
    });
    const report = await index(connector, { tenantId: "default", scopeId: "default", signal });

    expect(first.results.map((r) => r.text)).toEqual(["Leave is twenty five days a year."]);
    expect(report).toMatchObject({ documents: 1, skipped: 1 });
    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    db.close();
  });

  it("a shared source holds one copy under one key: every reader finds the same corpus", async () => {
    const { directory: folder, path } = await version0();
    const connector = new SqliteFtsRagSource({ directory: folder, path });

    const shared = await retrieve(connector, "leave", { topK: 5, signal });
    const again = await retrieve(connector, "leave", { topK: 5, signal });

    expect(shared.results.map((r) => r.text)).toEqual(["Leave is twenty five days a year."]);
    expect(again.results).toEqual(shared.results);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT COUNT(DISTINCT scope_id) AS n FROM files").get()).toEqual({ n: 1 });
    db.close();
  });

  it("a file of a later version is refused (rag.index-version) and left as it is", async () => {
    const folder = await mkdtemp(join(tmpdir(), "fts-v9-"));
    const path = join(folder, "fts.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 9");
    db.close();
    const connector = new SqliteFtsRagSource({ directory: folder, path });

    const refused = await retrieve(connector, "x", {
      topK: 1,
      tenantId: "default",
      scopeId: "default",
      signal,
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(RagIndexVersionError);
    expect(refused).toMatchObject({ code: "rag.index-version" });
    const after = new DatabaseSync(path);
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    after.close();
  });
});
