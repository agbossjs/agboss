import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkMarkdown, ftsQuery, SqliteFtsConnector } from "../../src/rag/sqlite-fts.js";

const signal = new AbortController().signal;
const tenantId = "default";
const asDefault = { tenantId, signal };

async function docs(): Promise<{ folder: string; connector: SqliteFtsConnector }> {
  const folder = await mkdtemp(join(tmpdir(), "fts-"));
  await writeFile(
    join(folder, "onboarding.md"),
    "# Onboarding\n\nOn-call starts after your third month.\n\n## Day 5\n\nDemo at the Friday show-and-tell.",
  );
  await writeFile(join(folder, "product.md"), "# Nimbus\n\nNimbus predicts frost and heavy rain.");
  await writeFile(join(folder, "notes.bin"), "ignored");
  return {
    folder,
    connector: new SqliteFtsConnector({ folder, dbFile: join(folder, "index", "fts.sqlite") }),
  };
}

describe("SQLite FTS5 connector (reference implementation)", () => {
  it("#700 AC3: re-indexing the same documents twice — or twice at once — leaves one set of chunks", async () => {
    const { connector } = await docs();
    const changed = await docs();

    const first = await connector.index(asDefault);
    await connector.index(asDefault);
    // two connections on one file, at once
    const other = new SqliteFtsConnector({
      folder: changed.folder,
      dbFile: join(changed.folder, "index", "fts.sqlite"),
    });
    await Promise.all([changed.connector.index(asDefault), other.index(asDefault)]);
    const everything = await connector.retrieve("onboarding nimbus call demo", {
      topK: 50,
      ...asDefault,
    });

    expect(first.chunks).toBe(3);
    expect(everything.results).toHaveLength(3);
    expect((await changed.connector.index(asDefault)).chunks).toBe(3);
  });

  it("#700: each tenant its own folder and its own chunks; a tenant without a folder has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-tenants-"));
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "a.md"), "Alpha secret is amber.");
    const folders = new Map([["Acme", join(root, "a")]]);
    const connector = new SqliteFtsConnector({
      folder: (tenant) => folders.get(tenant),
      dbFile: join(root, "fts.sqlite"),
    });

    const own = await connector.retrieve("alpha secret", { topK: 5, tenantId: "Acme", signal });
    const twin = await connector.retrieve("alpha secret", { topK: 5, tenantId: "acme", signal });

    expect(own.results.map((r) => r.source)).toEqual(["a.md"]);
    expect(twin.results).toEqual([]);
    expect(await connector.index({ tenantId: "acme", signal })).toEqual({
      documents: 0,
      chunks: 0,
      skipped: 0,
      costUsd: 0,
    });
  });

  it("#700: an aborted signal and a tenant id that is no key's text are refused before any statement, the id never echoed", async () => {
    const { connector } = await docs();
    const controller = new AbortController();
    controller.abort();
    const bad = "acme\u00A0corp";

    await expect(connector.index({ tenantId, signal: controller.signal })).rejects.toThrow();
    await expect(
      connector.retrieve("x", { topK: 1, tenantId, signal: controller.signal }),
    ).rejects.toThrow();
    const refused = await connector
      .retrieve("x", { topK: 1, tenantId: bad, signal })
      .catch((e: unknown) => e);
    expect((refused as Error).message).toContain("space-separator");
    expect((refused as Error).message).not.toContain(bad);
  });

  it("AC3: indexes Markdown, skips unchanged files, re-indexes a changed one; no cost", async () => {
    const { folder, connector } = await docs();

    const first = await connector.index(asDefault);
    const second = await connector.index(asDefault);
    await writeFile(
      join(folder, "product.md"),
      "# Nimbus\n\nNimbus predicts frost, rain and hail.",
    );
    const third = await connector.index(asDefault);

    expect(first).toEqual({ documents: 2, chunks: 3, skipped: 0, costUsd: 0 });
    expect(second.skipped).toBe(2);
    expect(third).toMatchObject({ documents: 2, skipped: 1 });
  });

  it("AC2: top-k results by BM25 with the file as source; builds the index on first use", async () => {
    const { connector } = await docs();

    const retrieval = await connector.retrieve("When does on-call start?", {
      topK: 1,
      ...asDefault,
    });

    expect(retrieval.results).toHaveLength(1);
    expect(retrieval.results[0]).toMatchObject({ source: "onboarding.md" });
    expect(retrieval.results[0]?.text).toContain("On-call starts after your third month.");
    expect(retrieval.costUsd).toBe(0);
  });

  it("no terms or no match → no results; k larger than the corpus returns what there is", async () => {
    const { connector } = await docs();

    expect((await connector.retrieve("?!", { topK: 3, ...asDefault })).results).toEqual([]);
    expect((await connector.retrieve("kubernetes", { topK: 3, ...asDefault })).results).toEqual([]);
    expect(
      (await connector.retrieve("Nimbus frost on-call", { topK: 50, ...asDefault })).results.length,
    ).toBeLessThanOrEqual(3);
  });

  it("chunks at headings, merges paragraphs up to the limit; queries are quoted words OR-ed", () => {
    expect(chunkMarkdown("# A\n\none\n\ntwo\n\n# B\n\nthree", 100)).toEqual([
      "# A\n\none\n\ntwo",
      "# B\n\nthree",
    ]);
    expect(chunkMarkdown("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
    expect(ftsQuery("On-call: when? on-call")).toBe('"on" OR "call" OR "when"');
    expect(ftsQuery("?")).toBeUndefined();
  });
});
