/**
 * #1226 — `node:sqlite` of Node 22.13–22.15 has no FTS5 module. The connector refuses with a typed
 * error naming the Node it needs, on its first use, instead of SQLite's "no such module: fts5".
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { retrieve, index } from "./access.js";
import { describe, expect, it, vi } from "vitest";

const noFts5 = vi.hoisted(() => ({ on: false }));

vi.mock("node:sqlite", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:sqlite")>();
  /** The real engine, but its FTS5 module is missing while `noFts5.on`. */
  class WithoutFts5 extends original.DatabaseSync {
    override exec(sql: string): void {
      if (noFts5.on && /USING\s+fts5/i.test(sql)) throw new Error("no such module: fts5");
      super.exec(sql);
    }
  }
  return { ...original, DatabaseSync: WithoutFts5 };
});

const { SqliteFtsRagSource } = await import("../../src/rag/sqlite-fts.js");
const { RagFts5UnavailableError, requireFts5 } = await import("../../src/rag/sqlite-fts-schema.js");

const signal = new AbortController().signal;

async function folderWithDocument(): Promise<{ directory: string; path: string }> {
  const folder = await mkdtemp(join(tmpdir(), "fts-no-fts5-"));
  await writeFile(join(folder, "leave.md"), "Leave is twenty five days a year.");
  return { directory: folder, path: join(folder, "fts.sqlite") };
}

describe("#1226: no FTS5 in node:sqlite fails closed", () => {
  it("retrieve and index refuse rag.fts5-unavailable, naming the Node needed, creating no index", async () => {
    const { directory: folder, path } = await folderWithDocument();
    const connector = new SqliteFtsRagSource({ directory: folder, path });
    noFts5.on = true;
    try {
      const retrieved = await retrieve(connector, "leave", {
        topK: 3,
        tenantId: "default",
        scopeId: "default",
        signal,
      }).catch((e: unknown) => e);
      const indexed = await index(connector, {
        tenantId: "default",
        scopeId: "default",
        signal,
      }).catch((e: unknown) => e);

      for (const refused of [retrieved, indexed]) {
        expect(refused).toBeInstanceOf(RagFts5UnavailableError);
        expect(refused).toMatchObject({ code: "rag.fts5-unavailable" });
        expect((refused as Error).message).toContain("22.16.0");
        expect((refused as Error).message).toContain(process.version);
        expect((refused as Error).message).not.toContain("no such module");
      }
    } finally {
      noFts5.on = false;
    }
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    db.close();
  });

  it("with FTS5 the connector works as before", async () => {
    const { directory: folder, path } = await folderWithDocument();
    const connector = new SqliteFtsRagSource({ directory: folder, path });
    const found = await retrieve(connector, "leave", {
      topK: 3,
      tenantId: "default",
      scopeId: "default",
      signal,
    });
    expect(found.results.map((r) => r.source)).toEqual(["leave.md"]);
  });

  it("an error that is not a missing module is rethrown as it is", () => {
    const broken = {
      exec: (): never => {
        throw new Error("disk I/O error");
      },
    };
    expect(() => {
      requireFts5(broken);
    }).toThrow("disk I/O error");
  });

  it("a probe leaves no table behind", () => {
    const db = new DatabaseSync(":memory:");
    requireFts5(db);
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
    db.close();
  });
});
