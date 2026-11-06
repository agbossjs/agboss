import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { checkedTenantId } from "../flow/context/context-values.js";
import { inTransaction, openSchema } from "./sqlite-fts-schema.js";
import type {
  RagConnector,
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
} from "./types.js";

/** Where the documents are and where the index lives. */
export interface SqliteFtsOptions {
  /**
   * The documents (#700): one folder every tenant gets (each tenant indexes its own copy), or a
   * tenant's own folder by its id — `undefined` when the tenant has none. Look the folder up; never
   * build a path from the id itself (a tenant id may hold `/` or `..`).
   */
  readonly folder: string | ((tenantId: string) => string | undefined);
  /** The SQLite file of the index (created with its folder) — as the core's SQLite stores call it. */
  readonly sqlitePath: string;
  /** Upper bound of a chunk, in characters (default 800). */
  readonly maxChunkLength?: number;
}

const DEFAULT_CHUNK_LENGTH = 800;
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_TERMS = 12;

/** Splits Markdown at headings, then merges paragraphs into chunks of at most `max` characters. */
export function chunkMarkdown(text: string, max: number): string[] {
  const paragraphs = text
    .split(/\n(?=#{1,6} )|\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.flatMap((p) =>
    p.length <= max ? [p] : (p.match(new RegExp(`[\\s\\S]{1,${String(max)}}`, "g")) ?? []),
  )) {
    const startsSection = /^#{1,6} /.test(paragraph);
    if (current !== "" && (startsSection || current.length + paragraph.length + 2 > max)) {
      chunks.push(current);
      current = "";
    }
    current = current === "" ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** A user question as an FTS5 query: its distinct words (2+ letters), quoted, OR-ed. */
export function ftsQuery(query: string): string | undefined {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((term) => term.length >= 2)
    .slice(0, MAX_TERMS);
  return terms.length === 0 ? undefined : terms.map((term) => `"${term}"`).join(" OR ");
}

const Hit = z.object({ source: z.string(), text: z.string(), rank: z.number() });
const Count = z.object({ n: z.number() });
const FileRow = z.object({ source: z.string(), hash: z.string() });

/** The Markdown files of a folder, sorted; no folder → none. */
async function documentsIn(folder: string | undefined): Promise<readonly string[]> {
  if (folder === undefined) return [];
  return (await readdir(folder, { recursive: true }))
    .filter((file) => DOCUMENT_EXTENSIONS.has(extname(file).toLowerCase()))
    .sort();
}

/**
 * Reference knowledge base: SQLite FTS5 full-text search ranked by BM25 over a folder of Markdown —
 * built into Node, no dependencies, no cost. Vector search would be another connector with the
 * same contract (e.g. sqlite-vec + an embeddings model). Every chunk is its tenant's (#700): a
 * retrieval reads, and an index writes, the tenant it is given only — compared as given.
 *
 * A tenant never indexed is indexed by its first retrieval on this instance (#818), once: later
 * retrievals only read, even when its folder has no documents. `agboss rag index` (or `index()`)
 * updates the index after the documents change.
 */
export class SqliteFtsConnector implements RagConnector {
  private db: DatabaseSync | undefined;
  /** Per tenant, its first retrieval's look at the index on this instance (and the index it built). */
  private readonly opened = new Map<string, Promise<void>>();

  constructor(private readonly options: SqliteFtsOptions) {}

  async index({ tenantId, signal }: RagIndexOptions): Promise<RagIndexReport> {
    checkedTenantId(tenantId);
    signal.throwIfAborted();
    const db = this.open();
    const known = new Map(
      db
        .prepare("SELECT source, hash FROM files WHERE tenant_id = ?")
        .all(tenantId)
        .map((row) => {
          const r = FileRow.parse(row);
          return [r.source, r.hash] as const;
        }),
    );
    const folder = this.folderOf(tenantId);
    const files = await documentsIn(folder);
    let skipped = 0;
    for (const source of files) {
      const text = await readFile(join(folder ?? "", source), "utf8");
      signal.throwIfAborted();
      const hash = createHash("sha256").update(text).digest("hex");
      if (known.get(source) === hash) {
        skipped += 1;
        continue;
      }
      const chunks = chunkMarkdown(text, this.options.maxChunkLength ?? DEFAULT_CHUNK_LENGTH);
      this.replace(db, { tenantId, source, hash }, chunks);
    }
    for (const gone of [...known.keys()].filter((source) => !files.includes(source)))
      this.replace(db, { tenantId, source: gone, hash: undefined }, []);
    const chunks = Count.parse(
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?").get(tenantId),
    ).n;
    return { documents: files.length, chunks, skipped, costUsd: 0 };
  }

  async retrieve(query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    const { tenantId, signal } = options;
    checkedTenantId(tenantId);
    signal.throwIfAborted();
    await this.openTenant(tenantId, signal);
    const db = this.open();
    const match = ftsQuery(query);
    if (match === undefined) return { results: [], costUsd: 0 };
    const hits = db
      .prepare(
        "SELECT source, text, bm25(chunks) AS rank FROM chunks WHERE chunks MATCH ? AND tenant_id = ? ORDER BY rank LIMIT ?",
      )
      .all(match, tenantId, options.topK)
      .map((row) => Hit.parse(row));
    return {
      results: hits.map((hit) => ({ source: hit.source, text: hit.text, score: -hit.rank })),
      costUsd: 0,
    };
  }

  /**
   * A tenant's first retrieval on this instance: its index built when it has none — once, however
   * many retrievals come at once. A look that failed (an abort, an unreadable folder) is no look:
   * the next retrieval tries again, and one that was only waiting on another's (aborted by its own
   * caller) tries its own, unless its own signal is aborted too.
   */
  private async openTenant(tenantId: string, signal: AbortSignal): Promise<void> {
    const pending = this.opened.get(tenantId);
    if (pending !== undefined) {
      try {
        await pending;
        return;
      } catch {
        signal.throwIfAborted();
        // whoever made it drops it too; never wait on a failed look twice
        if (this.opened.get(tenantId) === pending) this.opened.delete(tenantId);
        return this.openTenant(tenantId, signal);
      }
    }
    const look = this.indexIfEmpty(tenantId, signal);
    this.opened.set(tenantId, look);
    try {
      await look;
    } catch (error) {
      if (this.opened.get(tenantId) === look) this.opened.delete(tenantId);
      throw error;
    }
  }

  private async indexIfEmpty(tenantId: string, signal: AbortSignal): Promise<void> {
    const files = this.open()
      .prepare("SELECT COUNT(*) AS n FROM files WHERE tenant_id = ?")
      .get(tenantId);
    if (Count.parse(files).n === 0) await this.index({ tenantId, signal });
  }

  private folderOf(tenantId: string): string | undefined {
    const { folder } = this.options;
    return typeof folder === "string" ? folder : folder(tenantId);
  }

  /** One document's chunks of one tenant replaced at once (#700: never two sets, never half). */
  private replace(
    db: DatabaseSync,
    file: { readonly tenantId: string; readonly source: string; readonly hash: string | undefined },
    chunks: readonly string[],
  ): void {
    const { tenantId, source, hash } = file;
    inTransaction(db, () => {
      db.prepare("DELETE FROM chunks WHERE tenant_id = ? AND source = ?").run(tenantId, source);
      db.prepare("DELETE FROM files WHERE tenant_id = ? AND source = ?").run(tenantId, source);
      if (hash === undefined) return;
      const insert = db.prepare("INSERT INTO chunks (tenant_id, source, text) VALUES (?, ?, ?)");
      for (const chunk of chunks) insert.run(tenantId, source, chunk);
      db.prepare("INSERT INTO files VALUES (?, ?, ?)").run(tenantId, source, hash);
    });
  }

  private open(): DatabaseSync {
    if (this.db !== undefined) return this.db;
    mkdirSync(dirname(this.options.sqlitePath), { recursive: true });
    const db = new DatabaseSync(this.options.sqlitePath);
    try {
      openSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }
}
