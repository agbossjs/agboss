import { usd } from "../units/index.js";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { documentsIn, hashOf, keyOf, scopeOf } from "./sqlite-fts-key.js";
import { OncePerScope } from "./once-per-scope.js";
import { RagSource } from "./rag-source.js";
import { openSchema, requireFts5 } from "./sqlite-fts-schema.js";
import { writeScope } from "./sqlite-fts-write.js";
import type {
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
  RagScopeKey,
} from "./types.js";

/** Where the documents are and where the index lives. */
export interface SqliteFtsOptions {
  /**
   * The documents: one folder every scope shares (each scope indexes its own copy under a
   * tenant, owner or custom scope), or a scope's own folder by its id — `undefined` when the scope
   * has none (and for `RagScope.Shared`, `scopeId` is `undefined`). Look the folder up; never build
   * a path from the id itself (an id may hold `/` or `..`).
   */
  readonly directory:
    string | ((scopeId: string | undefined, tenantId: string | undefined) => string | undefined);
  /** The SQLite file of the index (created with its folder) — as the core's SQLite stores call it. */
  readonly path: string;
  /** Upper bound of a chunk, in characters (default 800). */
  readonly maxChunkLength?: number;
}

const DEFAULT_CHUNK_LENGTH = 800;
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

const Hit = z.object({ source: z.string(), text: z.string(), rank: z.number() });
const Count = z.object({ n: z.number() });
const FileRow = z.object({ source: z.string(), hash: z.string() });

/**
 * Reference knowledge base: SQLite FTS5 full-text search ranked by BM25 over a folder of Markdown —
 * built into Node, no dependencies, no cost. Vector search would be another connector with the
 * same contract (e.g. sqlite-vec + an embeddings model). Every chunk is its scope's: a
 * retrieval reads, and an index writes, the scope it is given only — compared as given.
 *
 * A scope never indexed is indexed by its first retrieval on this instance (#818), once and whole
 * (one transaction): later retrievals only read, even when its folder has no documents. `agboss rag
 * index` (or `index()`) updates the index after the documents change — whole, in one transaction
 * too (#891): an interrupted run leaves the index it found.
 */
export class SqliteFtsRagSource extends RagSource {
  private db: DatabaseSync | undefined;
  /** Per scope, its first retrieval's look at the index on this instance — once (#818). */
  private readonly firstLook = new OncePerScope((key, signal) => this.buildIfEmpty(key, signal));

  constructor(private readonly options: SqliteFtsOptions) {
    super();
  }

  /** Closes the index file's handle with the application. */
  onDestroy(): void {
    this.db?.close();
    this.db = undefined;
  }

  /**
   * The scope's index brought up to its folder whole or not at all (#891): every document is read
   * first, then every change — a changed document's chunks, a gone one's removal — is written in one
   * transaction on a connection of its own that gives the event loop back every few milliseconds
   * (`writeScope`): a Ctrl+C stops a long write at once, rolled back. An abort, an unreadable
   * document or a failure midway leaves the index as it was.
   */
  protected override async index({
    tenantId,
    scopeId,
    signal,
  }: RagIndexOptions): Promise<RagIndexReport> {
    const scope = {
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(scopeId === undefined ? {} : { scopeId }),
    };
    const key = keyOf(scope);
    signal.throwIfAborted();
    const db = this.open();
    const known = this.knownFilesOf(key);
    const documents = await this.documentsOf(scope, signal);
    const changed = documents.filter(({ hash, source }) => known.get(source) !== hash);
    const sources = new Set(documents.map(({ source }) => source));
    const gone = [...known.keys()].filter((source) => !sources.has(source));
    signal.throwIfAborted();
    await writeScope(this.options.path, signal, {
      scopeId: key,
      put: changed.map(({ source, hash, text }) => ({
        source,
        hash,
        chunks: () => this.chunksOf(text),
      })),
      remove: gone,
    });
    const chunks = Count.parse(
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE scope_id = ?").get(key),
    ).n;
    return {
      documents: documents.length,
      chunks,
      skipped: documents.length - changed.length,
      costUsd: usd(0),
    };
  }

  protected override async retrieve(
    query: string,
    options: RagRetrieveOptions,
  ): Promise<RagRetrieval> {
    const { tenantId, scopeId, signal } = options;
    const key = keyOf({
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(scopeId === undefined ? {} : { scopeId }),
    });
    signal.throwIfAborted();
    await this.firstLook.run(key, signal);
    signal.throwIfAborted();
    const db = this.open();
    const match = ftsQuery(query);
    if (match === undefined) return { results: [], costUsd: usd(0) };
    const hits = db
      .prepare(
        "SELECT source, text, bm25(chunks) AS rank FROM chunks WHERE chunks MATCH ? AND scope_id = ? ORDER BY rank LIMIT ?",
      )
      .all(match, key, options.topK)
      .map((row) => Hit.parse(row));
    return {
      results: hits.map((hit) => ({ source: hit.source, text: hit.text, score: -hit.rank })),
      costUsd: usd(0),
    };
  }

  /**
   * A scope's first retrieval on this instance, when its index has nothing yet: every document read
   * first, then all written in one transaction — an abort, an unreadable file or a crash midway
   * leaves nothing, so the next look builds it whole (a partial index would read as built).
   */
  private async buildIfEmpty(key: string, signal: AbortSignal): Promise<void> {
    if (this.fileCount(key) > 0) return;
    const documents = await this.documentsOf(scopeOf(key), signal);
    this.open();
    await writeScope(this.options.path, signal, {
      scopeId: key,
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

  /** Every document of the scope's folder, read whole before anything is written. */
  private async documentsOf(
    scope: RagScopeKey,
    signal: AbortSignal,
  ): Promise<readonly ReadDocument[]> {
    const folder = this.folderOf(scope);
    const documents: ReadDocument[] = [];
    for (const source of await documentsIn(folder)) {
      const text = await readFile(join(folder ?? "", source), "utf8");
      signal.throwIfAborted();
      documents.push({ source, text, hash: hashOf(text) });
    }
    return documents;
  }

  /** The documents the scope's index holds, by source, with the hash each was indexed at. */
  private knownFilesOf(key: string): ReadonlyMap<string, string> {
    return new Map(
      this.open()
        .prepare("SELECT source, hash FROM files WHERE scope_id = ?")
        .all(key)
        .map((row) => {
          const r = FileRow.parse(row);
          return [r.source, r.hash] as const;
        }),
    );
  }

  private fileCount(key: string): number {
    return Count.parse(
      this.open().prepare("SELECT COUNT(*) AS n FROM files WHERE scope_id = ?").get(key),
    ).n;
  }

  private chunksOf(text: string): string[] {
    return chunkMarkdown(text, this.options.maxChunkLength ?? DEFAULT_CHUNK_LENGTH);
  }

  private folderOf({ scopeId, tenantId }: RagScopeKey): string | undefined {
    const { directory } = this.options;
    return typeof directory === "string" ? directory : directory(scopeId, tenantId);
  }

  private open(): DatabaseSync {
    if (this.db !== undefined) return this.db;
    mkdirSync(dirname(this.options.path), { recursive: true });
    const db = new DatabaseSync(this.options.path);
    try {
      requireFts5(db);
      openSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }
}
