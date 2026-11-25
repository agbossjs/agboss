import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pauseThread } from "../clock.js";

/** How long a writer waits for another connection's lock before the store fails (milliseconds). */
export const BUSY_TIMEOUT = 5000;

/** SQLite's `SQLITE_BUSY` result code; its extended codes (`SQLITE_BUSY_RECOVERY` = 261, …) keep it in the low byte. */
const SQLITE_BUSY = 5;
const PRIMARY_CODE_MASK = 0xff;

/** The longest pause between two tries of the WAL switch (milliseconds); the pauses start at 1 and double. */
const LONGEST_PAUSE = 50;

/**
 * `PRAGMA journal_mode = WAL` (#911). On a new file, several connections opening it at once make
 * SQLite answer `SQLITE_BUSY` to the switch itself, at once and whatever the busy timeout (its busy
 * handler is not asked where waiting could deadlock) — so a busy answer (any of its extended codes: with the busy timeout at 0, SQLite no longer waits out `SQLITE_BUSY_RECOVERY` itself) is tried again, with a
 * growing pause, for `busyTimeout` in all, then fails as before. The caller sets SQLite's own
 * `busy_timeout` to 0 for these tries: a lock really held on a file not yet in WAL mode would make
 * SQLite wait the whole timeout inside every try, and the pauses counted here would no longer bound
 * the open. With 0, each try returns at once, so the pauses are the whole wait. The pause is a
 * blocking `pauseThread` (no `Clock` drives it): acceptable only because this is synchronous
 * startup, before the instance serves, and the total is bounded by `busyTimeout`.
 */
function switchToWal(database: DatabaseSync, busyTimeout: number): void {
  for (let waited = 0, next = 1; ;) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const isBusy =
        error instanceof Error &&
        "errcode" in error &&
        typeof error.errcode === "number" &&
        (error.errcode & PRIMARY_CODE_MASK) === SQLITE_BUSY;
      if (!isBusy || waited >= busyTimeout) throw error;
      const length = Math.min(next, busyTimeout - waited);
      pauseThread(length);
      waited += length;
      next = Math.min(next * 2, LONGEST_PAUSE);
    }
  }
}

/**
 * Opens (creating its folder) a database on `path` with the pragmas every SQLite store relies on.
 * The whole open — every try of the WAL switch included — is bounded by `busyTimeout` (#911): the
 * switch runs with SQLite's own busy timeout at 0, which is set to `busyTimeout` once it is done.
 */
export function openSqliteDatabase(path: string, busyTimeout: number = BUSY_TIMEOUT): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const database = new Database(path, { timeout: 0 });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    switchToWal(database, busyTimeout);
    database.exec(`PRAGMA busy_timeout = ${String(busyTimeout)}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
