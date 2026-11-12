import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { checkedTenantId } from "../flow/context/context-values.js";
import { OncePerTenant } from "./once-per-tenant.js";
import { openSchema } from "./sqlite-fts-schema.js";
import { writeTenant } from "./sqlite-fts-write.js";
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

/** One document as read from the folder: its text and the hash it is indexed at. */
interface ReadDocument {
  readonly source: string;
  readonly text: string;
  readonly hash: string;
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

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
 * A tenant never indexed is indexed by its first retrieval on this instance (#818), once and whole
 * (one transaction): later retrievals only read, even when its folder has no documents. `agboss rag
 * index` (or `index()`) updates the index after the documents change — whole, in one transaction
 * too (#891): an interrupted run leaves the index it found.
 */
export class SqliteFtsConnector implements RagConnector {
  private db: DatabaseSync | undefined;
  /** Per tenant, its first retrieval's look at the index on this instance — once (#818). */
  private readonly firstLook = new OncePerTenant((tenantId, signal) =>
    this.buildIfEmpty(tenantId, signal),
  );

  constructor(private readonly options: SqliteFtsOptions) {}

  /**
   * The tenant's index brought up to its folder whole or not at all (#891): every document is read
   * first, then every change — a changed document's chunks, a gone one's removal — is written in one
   * transaction on a connection of its own that gives the event loop back every few milliseconds
   * (`writeTenant`): a Ctrl+C stops a long write at once, rolled back. An abort, an unreadable
   * document or a failure midway leaves the index as it was.
   */
  async index({ tenantId, signal }: RagIndexOptions): Promise<RagIndexReport> {
    checkedTenantId(tenantId);
    signal.throwIfAborted();
    const db = this.open();
    const known = this.knownFilesOf(tenantId);
    const documents = await this.documentsOf(tenantId, signal);
    const changed = documents.filter(({ hash, source }) => known.get(source) !== hash);
    const sources = new Set(documents.map(({ source }) => source));
    const gone = [...known.keys()].filter((source) => !sources.has(source));
    signal.throwIfAborted();
    await writeTenant(this.options.sqlitePath, signal, {
      tenantId,
      put: changed.map(({ source, hash, text }) => ({
        source,
        hash,
        chunks: () => this.chunksOf(text),
      })),
      remove: gone,
    });
    const chunks = Count.parse(
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?").get(tenantId),
    ).n;
    return {
      documents: documents.length,
      chunks,
      skipped: documents.length - changed.length,
      costUsd: 0,
    };
  }

  async retrieve(query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    const { tenantId, signal } = options;
    checkedTenantId(tenantId);
    signal.throwIfAborted();
    await this.firstLook.run(tenantId, signal);
    signal.throwIfAborted();
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
   * A tenant's first retrieval on this instance, when its index has nothing yet: every document read
   * first, then all written in one transaction — an abort, an unreadable file or a crash midway
   * leaves nothing, so the next look builds it whole (a partial index would read as built).
   */
  private async buildIfEmpty(tenantId: string, signal: AbortSignal): Promise<void> {
    if (this.fileCount(tenantId) > 0) return;
    const documents = await this.documentsOf(tenantId, signal);
    this.open();
    await writeTenant(this.options.sqlitePath, signal, {
      tenantId,
      // another connection (or run) may have built it meanwhile: its index stands
      onlyIfEmpty: true,
      put: documents.map(({ source, hash, text }) => ({
        source,
        hash,
        chunks: () => this.chunksOf(text),
      })),
      remove: [],
    });
  }

  /** Every document of the tenant's folder, read whole before anything is written. */
  private async documentsOf(
    tenantId: string,
    signal: AbortSignal,
  ): Promise<readonly ReadDocument[]> {
    const folder = this.folderOf(tenantId);
    const documents: ReadDocument[] = [];
    for (const source of await documentsIn(folder)) {
      const text = await readFile(join(folder ?? "", source), "utf8");
      signal.throwIfAborted();
      documents.push({ source, text, hash: hashOf(text) });
    }
    return documents;
  }

  /** The documents the tenant's index holds, by source, with the hash each was indexed at. */
  private knownFilesOf(tenantId: string): ReadonlyMap<string, string> {
    return new Map(
      this.open()
        .prepare("SELECT source, hash FROM files WHERE tenant_id = ?")
        .all(tenantId)
        .map((row) => {
          const r = FileRow.parse(row);
          return [r.source, r.hash] as const;
        }),
    );
  }

  private fileCount(tenantId: string): number {
    return Count.parse(
      this.open().prepare("SELECT COUNT(*) AS n FROM files WHERE tenant_id = ?").get(tenantId),
    ).n;
  }

  private chunksOf(text: string): string[] {
    return chunkMarkdown(text, this.options.maxChunkLength ?? DEFAULT_CHUNK_LENGTH);
  }

  private folderOf(tenantId: string): string | undefined {
    const { folder } = this.options;
    return typeof folder === "string" ? folder : folder(tenantId);
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
