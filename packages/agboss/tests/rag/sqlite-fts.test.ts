import { usd } from "../../src/units/index.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieve, index } from "./access.js";
import { describe, expect, it } from "vitest";
import { chunkMarkdown, ftsQuery, SqliteFtsRagSource } from "../../src/rag/sqlite-fts.js";

const signal = new AbortController().signal;
const scopeId = "default";
const asDefault = { tenantId: scopeId, scopeId, signal };

async function docs(): Promise<{ folder: string; connector: SqliteFtsRagSource }> {
  const folder = await mkdtemp(join(tmpdir(), "fts-"));
  await writeFile(
    join(folder, "onboarding.md"),
    "# Onboarding\n\nOn-call starts after your third month.\n\n## Day 5\n\nDemo at the Friday show-and-tell.",
  );
  await writeFile(join(folder, "product.md"), "# Nimbus\n\nNimbus predicts frost and heavy rain.");
  await writeFile(join(folder, "notes.bin"), "ignored");
  return {
    folder,
    connector: new SqliteFtsRagSource({
      directory: folder,
      path: join(folder, "index", "fts.sqlite"),
    }),
  };
}

describe("SQLite FTS5 connector (reference implementation)", () => {
  it("#700 AC3: re-indexing the same documents twice — or twice at once — leaves one set of chunks", async () => {
    const { connector } = await docs();
    const changed = await docs();

    const first = await index(connector, asDefault);
    await index(connector, asDefault);
    // two connections on one file, at once
    const other = new SqliteFtsRagSource({
      directory: changed.folder,
      path: join(changed.folder, "index", "fts.sqlite"),
    });
    await Promise.all([index(changed.connector, asDefault), index(other, asDefault)]);
    const everything = await retrieve(connector, "onboarding nimbus call demo", {
      topK: 50,
      ...asDefault,
    });

    expect(first.chunks).toBe(3);
    expect(everything.results).toHaveLength(3);
    expect((await index(changed.connector, asDefault)).chunks).toBe(3);
  });

  it("#700: each tenant its own folder and its own chunks; a tenant without a folder has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-tenants-"));
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "a.md"), "Alpha secret is amber.");
    const folders = new Map([["Acme", join(root, "a")]]);
    const connector = new SqliteFtsRagSource({
      directory: (tenant) => (tenant === undefined ? undefined : folders.get(tenant)),
      path: join(root, "fts.sqlite"),
    });

    const own = await retrieve(connector, "alpha secret", {
      topK: 5,
      tenantId: "Acme",
      scopeId: "Acme",
      signal,
    });
    const twin = await retrieve(connector, "alpha secret", {
      topK: 5,
      tenantId: "acme",
      scopeId: "acme",
      signal,
    });

    expect(own.results.map((r) => r.source)).toEqual(["a.md"]);
    expect(twin.results).toEqual([]);
    expect(await index(connector, { tenantId: "acme", scopeId: "acme", signal })).toEqual({
      documents: 0,
      chunks: 0,
      skipped: 0,
      costUsd: usd(0),
    });
  });

  it("#700: an aborted signal and a tenant id that is no key's text are refused before any statement, the id never echoed", async () => {
    const { connector } = await docs();
    const controller = new AbortController();
    controller.abort();
    const bad = "acme\u00A0corp";

    await expect(
      index(connector, { tenantId: scopeId, scopeId, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      retrieve(connector, "x", { topK: 1, tenantId: scopeId, scopeId, signal: controller.signal }),
    ).rejects.toThrow();
    const refused = await retrieve(connector, "x", {
      topK: 1,
      tenantId: bad,
      scopeId: bad,
      signal,
    }).catch((e: unknown) => e);
    expect((refused as Error).message).toContain("space-separator");
    expect((refused as Error).message).not.toContain(bad);
  });

  it("AC3: indexes Markdown, skips unchanged files, re-indexes a changed one; no cost", async () => {
    const { folder, connector } = await docs();

    const first = await index(connector, asDefault);
    const second = await index(connector, asDefault);
    await writeFile(
      join(folder, "product.md"),
      "# Nimbus\n\nNimbus predicts frost, rain and hail.",
    );
    const third = await index(connector, asDefault);

    expect(first).toEqual({ documents: 2, chunks: 3, skipped: 0, costUsd: usd(0) });
    expect(second.skipped).toBe(2);
    expect(third).toMatchObject({ documents: 2, skipped: 1 });
  });

  it("AC2: top-k results by BM25 with the file as source; builds the index on first use", async () => {
    const { connector } = await docs();

    const retrieval = await retrieve(connector, "When does on-call start?", {
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

    expect((await retrieve(connector, "?!", { topK: 3, ...asDefault })).results).toEqual([]);
    expect((await retrieve(connector, "kubernetes", { topK: 3, ...asDefault })).results).toEqual(
      [],
    );
    expect(
      (await retrieve(connector, "Nimbus frost on-call", { topK: 50, ...asDefault })).results
        .length,
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

/**
 * #818 AC4: a retrieval reads — a tenant never indexed is indexed by its first retrieval on the
 * instance, once; later ones, a tenant without documents included, write nothing.
 */
describe("#818: the read path indexes lazily, once per tenant per instance", () => {
  /** A connector whose `folder` lookups are counted: each `index()` makes one. */
  async function counted(folders: ReadonlyMap<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-"));
    const looked: string[] = [];
    const connector = new SqliteFtsRagSource({
      directory: (tenant) => {
        looked.push(tenant ?? "");
        return tenant === undefined ? undefined : folders.get(tenant);
      },
      path: join(root, "fts.sqlite"),
    });
    return { connector, looked };
  }

  const ask = (connector: SqliteFtsRagSource, tenant: string, own = signal) =>
    retrieve(connector, "alpha secret", {
      topK: 5,
      tenantId: tenant,
      scopeId: tenant,
      signal: own,
    });

  it("a tenant without documents: its first retrieval indexes it, the next ones only read", async () => {
    const { connector, looked } = await counted(new Map());

    await ask(connector, "empty");
    await ask(connector, "empty");
    await ask(connector, "empty");

    expect(looked).toEqual(["empty"]);
  });

  it("a tenant with documents: found by its first retrieval; each tenant is looked at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-docs-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    const { connector, looked } = await counted(new Map([["acme", root]]));

    const first = await ask(connector, "acme");
    const second = await ask(connector, "acme");
    await ask(connector, "other");

    expect(first.results.map((r) => r.source)).toEqual(["a.md"]);
    expect(second.results.map((r) => r.source)).toEqual(["a.md"]);
    expect(looked).toEqual(["acme", "other"]);
  });

  it("first retrievals at once index once", async () => {
    const { connector, looked } = await counted(new Map());

    await Promise.all([ask(connector, "empty"), ask(connector, "empty"), ask(connector, "empty")]);

    expect(looked).toEqual(["empty"]);
  });

  it("an index already built (agboss rag index) is read as it is: no index on the read path", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-built-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    const { connector, looked } = await counted(new Map([["acme", root]]));
    await index(connector, { tenantId: "acme", scopeId: "acme", signal });
    looked.length = 0;

    await ask(connector, "acme");

    expect(looked).toEqual([]);
  });

  it("a first look that failed is no look: the next retrieval tries again", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-fail-"));
    let isBroken = true;
    const connector = new SqliteFtsRagSource({
      directory: () => {
        if (isBroken) throw new Error("folder unreadable");
        return undefined;
      },
      path: join(root, "fts.sqlite"),
    });

    await expect(ask(connector, "acme")).rejects.toThrow("folder unreadable");
    isBroken = false;

    await expect(ask(connector, "acme")).resolves.toEqual({ results: [], costUsd: usd(0) });
  });

  it("a first build stopped midway — an abort between two documents — leaves nothing: the next retrieval builds it whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-half-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    await writeFile(join(root, "b.md"), "Beta secret is blue.");
    const { connector } = await counted(new Map([["acme", root]]));
    const caller = new AbortController();

    const stopped = ask(connector, "acme", caller.signal);
    caller.abort(new Error("caller gone"));
    await expect(stopped).rejects.toThrow("caller gone");
    const next = await retrieve(connector, "secret", {
      topK: 5,
      tenantId: "acme",
      scopeId: "acme",
      signal,
    });

    expect(next.results.map((r) => r.source).sort()).toEqual(["a.md", "b.md"]);
  });

  it("a document that cannot be read fails the first build whole; once it can, the next retrieval finds every document", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-unreadable-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    await mkdir(join(root, "b.md")); // a folder named like a document: reading it fails
    await writeFile(join(root, "c.md"), "Gamma secret is green.");
    const { connector } = await counted(new Map([["acme", root]]));

    await expect(ask(connector, "acme")).rejects.toThrow();
    await rm(join(root, "b.md"), { recursive: true });
    await writeFile(join(root, "b.md"), "Beta secret is blue.");
    const next = await retrieve(connector, "secret", {
      topK: 5,
      tenantId: "acme",
      scopeId: "acme",
      signal,
    });

    expect(next.results.map((r) => r.source).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("a waiting retrieval whose own signal aborts stops waiting with its own reason; the first look goes on", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-own-abort-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    const { connector, looked } = await counted(new Map([["acme", root]]));
    const waiter = new AbortController();

    const first = ask(connector, "acme");
    const waiting = ask(connector, "acme", waiter.signal);
    waiter.abort(new Error("waiter gone"));

    await expect(waiting).rejects.toThrow("waiter gone");
    expect((await first).results.map((r) => r.source)).toEqual(["a.md"]);
    expect(looked).toEqual(["acme"]);
  });

  it("a first look that failed of itself fails its waiters too, once; the next retrieval tries again", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-shared-fail-"));
    let tries = 0;
    let isBroken = true;
    const connector = new SqliteFtsRagSource({
      directory: () => {
        tries += 1;
        if (isBroken) throw new Error("folder unreadable");
        return undefined;
      },
      path: join(root, "fts.sqlite"),
    });

    const results = await Promise.allSettled([ask(connector, "acme"), ask(connector, "acme")]);
    isBroken = false;

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(tries).toBe(1);
    await expect(ask(connector, "acme")).resolves.toEqual({ results: [], costUsd: usd(0) });
  });

  it("a retrieval waiting on another's first look, aborted by its own caller, tries its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-abort-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    const { connector, looked } = await counted(new Map([["acme", root]]));
    const first = new AbortController();

    const aborted = ask(connector, "acme", first.signal);
    const waiting = ask(connector, "acme");
    first.abort(new Error("caller gone"));

    await expect(aborted).rejects.toThrow("caller gone");
    expect((await waiting).results.map((r) => r.source)).toEqual(["a.md"]);
    expect(looked).toEqual(["acme", "acme"]);
  });

  it("a waiting retrieval whose own signal is aborted too gives up", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-lazy-both-"));
    await writeFile(join(root, "a.md"), "Alpha secret is amber.");
    const { connector, looked } = await counted(new Map([["acme", root]]));
    const shared = new AbortController();

    const one = ask(connector, "acme", shared.signal);
    const two = ask(connector, "acme", shared.signal);
    shared.abort(new Error("both gone"));

    // the waiter stops at its own abort at once, before the first look ends: both watched together
    await Promise.all([
      expect(one).rejects.toThrow("both gone"),
      expect(two).rejects.toThrow("both gone"),
    ]);
    expect(looked).toEqual(["acme"]);
  });
});
