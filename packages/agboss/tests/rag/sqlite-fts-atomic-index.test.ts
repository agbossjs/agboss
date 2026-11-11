import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteFtsConnector } from "../../src/rag/sqlite-fts.js";

/**
 * #891 AC5 — `index()` (what `agboss rag index` runs) builds a tenant's index whole or not at all:
 * every document is read first, then every change is written in one transaction. An interrupted run
 * (an abort, a document that cannot be read, a failure midway) leaves the tenant's earlier index as
 * it was — or none, which the first retrieval then builds whole (#818) — never a partial index the
 * read path would take as built.
 */

const signal = new AbortController().signal;
const tenantId = "acme";

async function folderWith(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "fts-atomic-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const connector = new SqliteFtsConnector({
    folder: root,
    sqlitePath: join(root, "i", "f.sqlite"),
  });
  return { root, connector };
}

const sourcesOf = async (connector: SqliteFtsConnector, query: string): Promise<string[]> =>
  (await connector.retrieve(query, { topK: 20, tenantId, signal })).results
    .map((hit) => `${hit.source}: ${hit.text}`)
    .sort();

describe("#891 AC5: an interrupted index run leaves no partial tenant index", () => {
  it("AC5: a re-index that fails midway keeps the earlier index whole — no document of the new run", async () => {
    const { root, connector } = await folderWith({
      "a.md": "Alpha secret is amber.",
      "b.md": "Beta secret is blue.",
      "c.md": "Gamma secret is green.",
    });
    await connector.index({ tenantId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await rm(join(root, "b.md"));
    await mkdir(join(root, "b.md")); // read after a.md: reading it fails the run midway

    await expect(connector.index({ tenantId, signal })).rejects.toThrow();

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

    await expect(connector.index({ tenantId, signal })).rejects.toThrow();
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
    await connector.index({ tenantId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await writeFile(join(root, "b.md"), "Beta secret is black now.");
    const caller = new AbortController();

    const run = connector.index({ tenantId, signal: caller.signal });
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
    await connector.index({ tenantId, signal });
    await writeFile(join(root, "a.md"), "Alpha secret is azure now.");
    await rm(join(root, "b.md"));

    const report = await connector.index({ tenantId, signal });

    expect(report).toEqual({ documents: 1, chunks: 1, skipped: 0, costUsd: 0 });
    expect(await sourcesOf(connector, "secret")).toEqual(["a.md: Alpha secret is azure now."]);
  });
});
