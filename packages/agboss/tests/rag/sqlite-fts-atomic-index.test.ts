import { usd } from "../../src/units/index.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { retrieve, index } from "./access.js";
import { describe, expect, it } from "vitest";
import { SqliteFtsRagSource } from "../../src/rag/sqlite-fts.js";

/**
 * #891 AC5 — `index()` (what `agboss rag index` runs) builds a tenant's index whole or not at all:
 * every document is read first, then every change is written in one transaction. An interrupted run
 * (an abort, a document that cannot be read, a failure midway) leaves the tenant's earlier index as
 * it was — or none, which the first retrieval then builds whole (#818) — never a partial index the
 * read path would take as built.
 */

const signal = new AbortController().signal;
const scopeId = "acme";

async function folderWith(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "fts-atomic-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const connector = new SqliteFtsRagSource({
    directory: root,
    path: join(root, "i", "f.sqlite"),
  });
  return { root, connector };
}

const sourcesOf = async (connector: SqliteFtsRagSource, query: string): Promise<string[]> =>
  (await retrieve(connector, query, { topK: 20, tenantId: scopeId, scopeId, signal })).results
    .map((hit) => `${hit.source}: ${hit.text}`)
    .sort();

describe("#891 AC5: an interrupted index run leaves no partial tenant index", () => {
  it("AC5: a re-index that fails midway keeps the earlier index whole — no document of the new run", async () => {
    const { root, connector } = await folderWith({
      "a.md": "Alpha secret is amber.",
      "b.md": "Beta secret is blue.",
      "c.md": "Gamma secret is green.",
    });
    await index(connector, { tenantId: scopeId, scopeId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await rm(join(root, "b.md"));
    await mkdir(join(root, "b.md")); // read after a.md: reading it fails the run midway

    await expect(index(connector, { tenantId: scopeId, scopeId, signal })).rejects.toThrow();

    expect(await sourcesOf(connector, "secret")).toEqual([
      "a.md: Alpha secret is amber.",
      "b.md: Beta secret is blue.",
      "c.md: Gamma secret is green.",
    ]);
  });

  it("AC5: a first index that fails midway leaves nothing: the first retrieval builds it whole", async () => {
    const { root, connector } = await folderWith({
      "a.md": "Alpha secret is amber.",
      "c.md": "Gamma secret is green.",
    });
    await mkdir(join(root, "b.md"));

    await expect(index(connector, { tenantId: scopeId, scopeId, signal })).rejects.toThrow();
    await rm(join(root, "b.md"), { recursive: true });
    await writeFile(join(root, "b.md"), "Beta secret is blue.");

    expect(await sourcesOf(connector, "secret")).toEqual([
      "a.md: Alpha secret is amber.",
      "b.md: Beta secret is blue.",
      "c.md: Gamma secret is green.",
    ]);
  });

  it("AC5: a run aborted after its first document keeps the earlier index whole", async () => {
    const { root, connector } = await folderWith({
      "a.md": "Alpha secret is amber.",
      "b.md": "Beta secret is blue.",
    });
    await index(connector, { tenantId: scopeId, scopeId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await writeFile(join(root, "b.md"), "Beta secret is black now.");
    const caller = new AbortController();

    const run = index(connector, { tenantId: scopeId, scopeId, signal: caller.signal });
    caller.abort(new Error("interrupted"));
    await expect(run).rejects.toThrow("interrupted");

    expect(await sourcesOf(connector, "secret")).toEqual([
      "a.md: Alpha secret is amber.",
      "b.md: Beta secret is blue.",
    ]);
  });

  it("AC5: a run that completes replaces every changed document and drops the gone ones at once", async () => {
    const { root, connector } = await folderWith({
      "a.md": "Alpha secret is amber.",
      "b.md": "Beta secret is blue.",
    });
    await index(connector, { tenantId: scopeId, scopeId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await rm(join(root, "b.md"));

    const report = await index(connector, { tenantId: scopeId, scopeId, signal });

    expect(report).toEqual({ documents: 1, chunks: 1, skipped: 0, costUsd: usd(0) });
    expect(await sourcesOf(connector, "secret")).toEqual(["a.md: Alpha secret is azure now."]);
  });

  it("AC5/D1: an abort that arrives while the write phase runs stops it at once and rolls it back", async () => {
    const body = (version: string): string =>
      Array.from(
        { length: 40 },
        (_, n) => `## Part ${String(n)}\n\n${version} secret ${String(n)}`,
      ).join("\n\n");
    const files = Object.fromEntries(
      Array.from({ length: 400 }, (_, n) => [`d${String(n)}.md`, body("old")]),
    );
    const { root, connector } = await folderWith(files);
    const path = join(root, "i", "f.sqlite");
    await index(connector, { tenantId: scopeId, scopeId, signal });
    const oldChunks = (await sourcesOf(connector, "old")).length;
    for (const name of Object.keys(files)) await writeFile(join(root, name), body("new"));
    const caller = new AbortController();
    const probe = new DatabaseSync(path);
    probe.exec("PRAGMA busy_timeout = 0");
    const writing = (): boolean => {
      try {
        probe.exec("BEGIN IMMEDIATE; ROLLBACK");
        return false;
      } catch {
        return true; // the write lock is held: the write phase runs
      }
    };

    const run = index(connector, { tenantId: scopeId, scopeId, signal: caller.signal });
    const settled = run.then(
      () => "done",
      () => "aborted",
    );
    // each turn of this loop is the write phase giving the event loop back; the old code never did
    while (!writing()) await new Promise((resolve) => setImmediate(resolve));
    // a retrieval beside the write phase reads the committed index, none of the new run's rows
    expect(await sourcesOf(connector, "new")).toEqual([]);
    caller.abort(new Error("interrupted"));

    await expect(run).rejects.toThrow("interrupted");
    expect(await settled).toBe("aborted");
    expect(probe.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    probe.exec("BEGIN IMMEDIATE; ROLLBACK"); // no transaction is left open: the next writer is not locked out
    probe.close();
    expect((await sourcesOf(connector, "old")).length).toBe(oldChunks);
    expect(await sourcesOf(connector, "new")).toEqual([]);
    await expect(index(connector, { tenantId: scopeId, scopeId, signal })).resolves.toMatchObject({
      documents: 400,
    });
  });
});
