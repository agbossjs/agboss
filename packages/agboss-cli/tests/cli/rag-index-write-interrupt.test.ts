import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteFtsConnector } from "../../../agboss/src/rag/sqlite-fts.js";
import { fixture } from "./agboss.js";

/**
 * #891 D1: a real SIGINT during the write phase of `agboss rag index` (a real process, a real
 * SQLite file) stops it within a slice, exits 1 with `rag.interrupted`, and leaves the earlier index
 * whole — it was ignored until the whole transaction had committed, then exited 0.
 */

const main = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const APPLICATION = fixture("cli/rag-write-interrupt.application.ts");
const DOCUMENTS = 1500;
const names = Array.from({ length: DOCUMENTS }, (_, n) => `d${String(n)}.md`);
const text = (name: string, version: string): string =>
  `# ${name}\n\n${`${version} secret of ${name} is amber. `.repeat(40)}\n\n${"more words. ".repeat(60)}`;

/** The write lock is held: another connection cannot begin a write now (the write phase runs). */
function writing(sqlitePath: string): boolean {
  const probe = new DatabaseSync(sqlitePath);
  try {
    probe.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

describe("#891 D1: SIGINT in the write phase of agboss rag index", () => {
  it("D1: exit 1, rag.interrupted, the old index whole and SQLite intact", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rag-write-"));
    const sqlitePath = join(folder, "index.sqlite");
    for (const name of names) await writeFile(join(folder, name), text(name, "old"));
    const old = new SqliteFtsConnector({ folder, sqlitePath });
    await old.index({ tenantId: "default", signal: new AbortController().signal });
    for (const name of names) await writeFile(join(folder, name), text(name, "new"));

    const countOf = (like: string): unknown => {
      const db = new DatabaseSync(sqlitePath);
      try {
        return db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE ?").get(`%${like}%`);
      } finally {
        db.close();
      }
    };
    const before = countOf("old secret");

    let stdout = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", main, "rag", "index", "--application", APPLICATION, "--json"],
      {
        cwd: new URL("../..", import.meta.url).pathname, // where tsx resolves from
        env: {
          PATH: process.env.PATH,
          NO_COLOR: "1",
          RAG_WRITE_FOLDER: folder,
          RAG_WRITE_SQLITE: sqlitePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const deadline = Date.now() + 60_000;
    while (!writing(sqlitePath)) {
      if (Date.now() > deadline) throw new Error("the write phase did not start in 60 s");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    child.kill("SIGINT");

    expect(await exited).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "rag.interrupted" } });
    const db = new DatabaseSync(sqlitePath);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
    expect(countOf("old secret")).toEqual(before);
    expect(countOf("new secret")).toEqual({ n: 0 });
  }, 120_000);
});
