import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { storedTextOf, textOf, toTern } from "./schema.js";
import type { MemoryStore, Summary, Tern } from "./types.js";

const SummaryRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  thread_id: z.string(),
  bundle: z.string(),
  from_tern: z.string(),
  to_tern: z.string(),
  turns: z.number(),
  text: z.string(),
  cost_usd: z.number(),
  created_at: z.string(),
  compaction: z.string(),
});

const toSummary = (row: unknown): Summary => {
  const r = SummaryRow.parse(row);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    bundle: r.bundle,
    compaction: r.compaction,
    fromTernId: r.from_tern,
    toTernId: r.to_tern,
    turns: r.turns,
    text: textOf(r.text),
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
};

const Count = z.object({ n: z.number() });
const Seq = z.object({ seq: z.number() });

const seqOf = (db: DatabaseSync, ternId: string): number =>
  Seq.parse(db.prepare("SELECT rowid AS seq FROM terns WHERE id = ?").get(ternId)).seq;

/** A thread as the queries name it: its tenant and its id (#261 S72). */
const OF_THREAD = "tenant_id = ? AND thread_id = ?";

/** A compaction's summaries of a thread (#120 PR 3). */
const OF_COMPACTION = `${OF_THREAD} AND compaction = ?`;

const lastCovered = (
  db: DatabaseSync,
  tenantId: string,
  threadId: string,
  compaction: string,
): number =>
  Count.parse(
    db
      .prepare(`SELECT COALESCE(MAX(to_seq), 0) AS n FROM summaries WHERE ${OF_COMPACTION}`)
      .get(tenantId, threadId, compaction),
  ).n;

function turnReads(db: DatabaseSync): Pick<MemoryStore, "uncovered" | "before" | "turnNumber"> {
  const terns = (sql: string, ...params: SQLInputValue[]): Tern[] =>
    db
      .prepare(sql)
      .all(...params)
      .map(toTern);
  return {
    uncovered: (tenantId, threadId, compaction) =>
      Promise.resolve(
        terns(
          `SELECT * FROM terns WHERE ${OF_THREAD} AND rowid > ? ORDER BY rowid`,
          tenantId,
          threadId,
          lastCovered(db, tenantId, threadId, compaction),
        ),
      ),
    before: (tenantId, threadId, ternId, limit) =>
      Promise.resolve(
        terns(
          `SELECT * FROM (SELECT rowid AS seq, * FROM terns WHERE ${OF_THREAD} AND rowid < ?
           ORDER BY rowid DESC LIMIT ?) ORDER BY seq`,
          tenantId,
          threadId,
          seqOf(db, ternId),
          limit,
        ),
      ),
    turnNumber: (tenantId, threadId, ternId) =>
      Promise.resolve(
        Count.parse(
          db
            .prepare(`SELECT COUNT(*) AS n FROM terns WHERE ${OF_THREAD} AND rowid <= ?`)
            .get(tenantId, threadId, seqOf(db, ternId)),
        ).n,
      ),
  };
}

function summaryMethods(
  db: DatabaseSync,
  now: () => Date,
): Pick<MemoryStore, "addSummary" | "latestSummaries" | "summaryCount"> {
  return {
    addSummary: (summary) => {
      const stored: Summary = { ...summary, id: randomUUID(), createdAt: now().toISOString() };
      db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        stored.id,
        stored.tenantId,
        stored.threadId,
        stored.bundle,
        stored.fromTernId,
        stored.toTernId,
        seqOf(db, stored.fromTernId),
        seqOf(db, stored.toTernId),
        stored.turns,
        storedTextOf(stored.text),
        stored.costUsd,
        stored.createdAt,
        stored.compaction,
      );
      return Promise.resolve(stored);
    },
    latestSummaries: (tenantId, threadId, compaction, limit) =>
      Promise.resolve(
        db
          .prepare(
            `SELECT * FROM (SELECT * FROM summaries WHERE ${OF_COMPACTION}
             ORDER BY to_seq DESC LIMIT ?) ORDER BY to_seq`,
          )
          .all(tenantId, threadId, compaction, limit)
          .map(toSummary),
      ),
    summaryCount: (tenantId, threadId, compaction) =>
      Promise.resolve(
        Count.parse(
          db
            .prepare(`SELECT COUNT(*) AS n FROM summaries WHERE ${OF_COMPACTION}`)
            .get(tenantId, threadId, compaction),
        ).n,
      ),
  };
}

/** Conversation memory on the Tern database (table `summaries`, migration 3). */
export const memoryMethods = (db: DatabaseSync, now: () => Date): MemoryStore => ({
  ...turnReads(db),
  ...summaryMethods(db, now),
});
