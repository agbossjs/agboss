/**
 * An owner id (or a custom key) is unique within a tenant only: the index keys every row on the
 * pair (tenant, scope id) — never on the scope id alone, never on a concatenation. Two tenants
 * with one owner id never read, nor index, each other's documents.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteFtsRagSource } from "../../src/rag/sqlite-fts.js";
import { RagScope } from "../../src/rag/types.js";
import { index, retrieve } from "./access.js";

const signal = new AbortController().signal;

/** A source over folders named by (tenant, owner): `folders` maps "tenant|owner" to a folder. */
async function sourceOf(documents: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "fts-bound-"));
  const folders = new Map<string, string>();
  for (const [pair, text] of Object.entries(documents)) {
    const folder = join(root, String(folders.size));
    await mkdir(folder);
    await writeFile(join(folder, "doc.md"), text);
    folders.set(pair, folder);
  }
  const looked: string[] = [];
  const source = new SqliteFtsRagSource({
    directory: ({ scopeId, tenantId }) => {
      looked.push(`${String(tenantId)}|${String(scopeId)}`);
      return folders.get(`${String(tenantId)}|${String(scopeId)}`);
    },
    path: join(root, "index.sqlite"),
  });
  return { source, looked };
}

const askAs = (source: SqliteFtsRagSource, tenantId: string, scopeId: string) =>
  retrieve(source, "plum vault", { topK: 5, tenantId, scopeId, signal }).then((found) =>
    found.results.map((result) => result.text),
  );

describe("the same owner id in two tenants", () => {
  it("retrieve: neither tenant sees the other's documents", async () => {
    const { source } = await sourceOf({
      "tenant-a|alice": "The plum vault of tenant A.",
      "tenant-b|alice": "The plum vault of tenant B.",
    });

    expect(await askAs(source, "tenant-a", "alice")).toEqual(["The plum vault of tenant A."]);
    expect(await askAs(source, "tenant-b", "alice")).toEqual(["The plum vault of tenant B."]);
  });

  it("index: building one tenant's owner leaves the other's index as it was", async () => {
    const { source } = await sourceOf({
      "tenant-a|alice": "The plum vault of tenant A.",
      "tenant-b|alice": "The plum vault of tenant B.",
    });
    await askAs(source, "tenant-b", "alice");

    const report = await index(source, { tenantId: "tenant-a", scopeId: "alice", signal });

    expect(report).toMatchObject({ documents: 1, chunks: 1, skipped: 0 });
    expect(await askAs(source, "tenant-b", "alice")).toEqual(["The plum vault of tenant B."]);
    expect(await askAs(source, "tenant-a", "alice")).toEqual(["The plum vault of tenant A."]);
  });

  it("a tenant with no folder for that owner reads nothing, never the other tenant's", async () => {
    const { source } = await sourceOf({ "tenant-a|alice": "The plum vault of tenant A." });

    expect(await askAs(source, "tenant-b", "alice")).toEqual([]);
  });
});

describe("a crafted id never collides with another pair's key", () => {
  it("('a', 'b:c') and ('a:b', 'c') are two scopes, whatever the separator", async () => {
    const { source, looked } = await sourceOf({
      "a|b:c": "The plum vault of the first.",
      "a:b|c": "The plum vault of the second.",
      'a","b|c': "The plum vault of the crafted one.",
    });

    expect(await askAs(source, "a", "b:c")).toEqual(["The plum vault of the first."]);
    expect(await askAs(source, "a:b", "c")).toEqual(["The plum vault of the second."]);
    // a JSON-looking id is just text: it is its own pair
    expect(await askAs(source, 'a","b', "c")).toEqual(["The plum vault of the crafted one."]);
    expect(looked.filter((entry) => !entry.includes("another-tenant"))).toEqual([
      "a|b:c",
      "a:b|c",
      'a","b|c',
    ]);
  });

  it("a scope with a tenant and no id (or an id and no tenant) is no scope: it fails closed", async () => {
    const { source } = await sourceOf({});

    await expect(retrieve(source, "x", { topK: 1, tenantId: "a", signal })).rejects.toThrow(
      /neither \(shared\)/u,
    );
    await expect(retrieve(source, "x", { topK: 1, scopeId: "a", signal })).rejects.toThrow(
      /neither \(shared\)/u,
    );
  });
});

describe("the directory callback is asked for the whole scope key and must depend on the tenant", () => {
  const folderOf = async (root: string, name: string): Promise<string> => {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "doc.md"), `The plum vault of ${name}.`);
    return folder;
  };

  it("gets one object { tenantId, scopeId, scope }, and the same owner id in two tenants gets two folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-dir-key-"));
    const folders = new Map([
      ["tenant-a|alice", await folderOf(root, "tenant-a")],
      ["tenant-b|alice", await folderOf(root, "tenant-b")],
    ]);
    const keys: unknown[] = [];
    const source = new SqliteFtsRagSource({
      directory: (key) => {
        keys.push(key);
        return folders.get(`${String(key.tenantId)}|${String(key.scopeId)}`);
      },
      path: join(root, "index.sqlite"),
    });

    const asA = await retrieve(source, "plum vault", {
      topK: 5,
      tenantId: "tenant-a",
      scopeId: "alice",
      scope: RagScope.Owner,
      signal,
    });

    expect(asA.results.map((r) => r.text)).toEqual(["The plum vault of tenant-a."]);
    expect(keys[0]).toEqual({ tenantId: "tenant-a", scopeId: "alice", scope: RagScope.Owner });
  });

  it("a callback keyed on the scope id alone is refused at first use: fail closed, nothing indexed", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-dir-alone-"));
    const shared = await folderOf(root, "one-folder-for-alice");
    const source = new SqliteFtsRagSource({
      directory: ({ scopeId }) => (scopeId === "alice" ? shared : undefined),
      path: join(root, "index.sqlite"),
    });

    await expect(
      retrieve(source, "plum vault", {
        topK: 5,
        tenantId: "tenant-a",
        scopeId: "alice",
        scope: RagScope.Owner,
        signal,
      }),
    ).rejects.toThrow(/rag\.directory-not-tenant-keyed/u);
  });

  it("the same refusal at index time", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-dir-alone-index-"));
    const shared = await folderOf(root, "one-folder-for-alice");
    const source = new SqliteFtsRagSource({
      directory: ({ scopeId }) => (scopeId === "alice" ? shared : undefined),
      path: join(root, "index.sqlite"),
    });

    await expect(
      index(source, { tenantId: "tenant-a", scopeId: "alice", scope: RagScope.Custom, signal }),
    ).rejects.toThrow(/rag\.directory-not-tenant-keyed/u);
  });

  it("a shared scope may have one folder: it has no tenant to depend on", async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-dir-shared-"));
    const shared = await folderOf(root, "help");
    const source = new SqliteFtsRagSource({
      directory: () => shared,
      path: join(root, "index.sqlite"),
    });
    const callback = new SqliteFtsRagSource({
      directory: ({ scope }) => (scope === RagScope.Shared ? shared : undefined),
      path: join(root, "index2.sqlite"),
    });

    for (const one of [source, callback])
      expect(
        (await retrieve(one, "plum vault", { topK: 5, scope: RagScope.Shared, signal })).results,
      ).toHaveLength(1);
  });
});
