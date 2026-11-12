import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** One document the write puts in its tenant's index: its chunks are made when its turn comes. */
export interface DocumentPut {
  readonly source: string;
  readonly hash: string;
  readonly chunks: () => readonly string[];
}

/** What one write phase changes in one tenant's index (#891). */
export interface TenantChange {
  readonly tenantId: string;
  readonly put: readonly DocumentPut[];
  /** Documents that are gone from the folder. */
  readonly remove: readonly string[];
  /** The write is skipped when the tenant already has documents indexed (a first build, #818). */
  readonly onlyIfEmpty?: boolean;
}

/**
 * How many rows a write phase handles before it gives the event loop back (a signal needs it): a
 * few tens of milliseconds of work, counted in rows — the time is the Clock's, not read here.
 */
const SLICE_ROWS = 2000;
/** The rowids one delete statement covers: it reads that window of the FTS5 table, not all of it. */
const WINDOW = 4000;
const Bounds = z.object({ low: z.number().nullable(), high: z.number().nullable() });
const Count = z.object({ n: z.number() });

/** The steps of a change, each short: the deletes by rowid window, then every document's insert. */
function* stepsOf(db: DatabaseSync, change: TenantChange): Generator<() => number> {
  const { tenantId } = change;
  const stale = [...change.put.map(({ source }) => source), ...change.remove];
  db.exec("CREATE TEMP TABLE stale (source TEXT PRIMARY KEY) WITHOUT ROWID");
  const mark = db.prepare("INSERT OR IGNORE INTO stale VALUES (?)");
  for (let from = 0; from < stale.length; from += WINDOW)
    yield () => {
      const batch = stale.slice(from, from + WINDOW);
      for (const source of batch) mark.run(source);
      return batch.length;
    };
  const { low, high } = Bounds.parse(
    db.prepare("SELECT MIN(rowid) AS low, MAX(rowid) AS high FROM chunks").get(),
  );
  // one scan of the table in all, in windows: a delete by (tenant, source) per file scans it whole
  for (let at = low ?? 0; low !== null && at <= (high ?? 0); at += WINDOW)
    yield () => {
      db.prepare(
        `DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE rowid BETWEEN ? AND ?
          AND tenant_id = ? AND source IN (SELECT source FROM stale))`,
      ).run(at, at + WINDOW - 1, tenantId);
      return WINDOW;
    };
  yield () => {
    db.prepare(
      "DELETE FROM files WHERE tenant_id = ? AND source IN (SELECT source FROM stale)",
    ).run(tenantId);
    return stale.length;
  };
  const insert = db.prepare("INSERT INTO chunks (tenant_id, source, text) VALUES (?, ?, ?)");
  const mark2 = db.prepare("INSERT INTO files VALUES (?, ?, ?)");
  for (const { source, hash, chunks } of change.put)
    yield () => {
      const made = chunks();
      for (const chunk of made) insert.run(tenantId, source, chunk);
      mark2.run(tenantId, source, hash);
      return made.length + 1;
    };
}

/** Per index file, the write phase now running or last run: writers of this process queue on it. */
const queues = new Map<string, Promise<void>>();

/**
 * Writes a tenant's change on a connection of its own, in one `BEGIN IMMEDIATE` transaction — all
 * of it or none (#891). Readers on the connector's own connection keep the committed index (WAL)
 * until the commit. The event loop is given back every couple of thousand rows and `signal` is checked
 * there and right before the commit: Ctrl+C rolls the transaction back and throws the signal's
 * reason, so a long write stops within a slice and the index stays as it was.
 */
export function writeTenant(
  sqlitePath: string,
  signal: AbortSignal,
  change: TenantChange,
): Promise<void> {
  const run = (queues.get(sqlitePath) ?? Promise.resolve()).then(() =>
    writeNow(sqlitePath, signal, change),
  );
  queues.set(
    sqlitePath,
    run.catch(() => undefined),
  );
  return run;
}

async function writeNow(
  sqlitePath: string,
  signal: AbortSignal,
  change: TenantChange,
): Promise<void> {
  signal.throwIfAborted();
  const db = new DatabaseSync(sqlitePath);
  try {
    // another process may hold the file: SQLite waits for it here (the wait blocks this process,
    // which is why this process's own writers queue instead: none of them could go on meanwhile)
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      db.exec("PRAGMA journal_mode = WAL"); // readers keep the committed index meanwhile
    } catch {
      // the file is held just now: the index stays in its journal mode, which works too
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const held = db.prepare("SELECT COUNT(*) AS n FROM files WHERE tenant_id = ?");
      if (change.onlyIfEmpty === true && Count.parse(held.get(change.tenantId)).n > 0) {
        db.exec("ROLLBACK");
        return;
      }
      let sliced = 0;
      for (const step of stepsOf(db, change)) {
        sliced += step();
        if (sliced < SLICE_ROWS) continue;
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal.throwIfAborted();
        sliced = 0;
      }
      signal.throwIfAborted();
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
