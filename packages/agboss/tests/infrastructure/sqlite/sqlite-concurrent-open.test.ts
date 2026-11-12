/**
 * #911: N application instances starting at the same moment on one brand-new SQLite file all
 * start. The WAL switch of a fresh file can answer "database is locked" at once, whatever the busy
 * timeout — `openSqliteDatabase` retries it, bounded by the busy timeout, never a fixed sleep.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../../../src/infrastructure/sqlite/sqlite-connection.js";

const SCRIPT = fileURLToPath(new URL("./concurrent-open-process.ts", import.meta.url));
const PROCESSES = 8;
const ROUNDS = 12;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-open-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Starts `PROCESSES` children, releases them together once all are ready; each one's last line. */
async function openTogether(path: string): Promise<string[]> {
  const children = Array.from({ length: PROCESSES }, () =>
    spawn(process.execPath, ["--import", "tsx", SCRIPT, path], {
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
  const ready = new Set<unknown>();
  const outputs = children.map((child) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.startsWith("ready\n") && !ready.has(child)) {
        ready.add(child);
        if (ready.size === PROCESSES) for (const each of children) each.stdin.write("go\n");
      }
    });
    return new Promise<string>((resolve) => {
      child.on("close", () => {
        resolve(output.trim().split("\n").at(-1) ?? "");
      });
    });
  });
  return Promise.all(outputs);
}

/** A connection holding the write lock of a file still in rollback-journal mode (not WAL). */
function holdLocked(path: string): DatabaseSync {
  const holder = new DatabaseSync(path);
  holder.exec("PRAGMA journal_mode = DELETE; CREATE TABLE held (id INTEGER); BEGIN EXCLUSIVE");
  return holder;
}

function release(holder: DatabaseSync): void {
  holder.exec("ROLLBACK");
  holder.close();
}

/**
 * The open ends within the busy timeout, not at a multiple of it. A try that waits the whole timeout
 * inside SQLite (the #921 regression) takes ~9x here, so 4x is a margin a loaded machine does not
 * reach while a second SQLite-side wait still cannot pass it.
 */
function expectWithinBusyTimeout(elapsed: number, busyTimeout: number): void {
  expect(elapsed).toBeLessThan(busyTimeout * 4);
}

describe("#911: a new SQLite file opened by several processes at once", () => {
  it("#911 AC1: every process opens it and creates its tables, round after round", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const results = await openTogether(join(dir, `round-${String(round)}`, "app.sqlite"));

      expect(results).toEqual(Array.from({ length: PROCESSES }, () => "opened"));
    }
  }, 120_000);

  it("#911 AC1: a file another connection holds locked still fails once the busy timeout is spent, within it", () => {
    const busyTimeout = 100;
    const holder = holdLocked(join(dir, "held.sqlite"));

    const start = performance.now();
    expect(() => openSqliteDatabase(join(dir, "held.sqlite"), busyTimeout)).toThrow(
      /database is locked/,
    );
    const elapsed = performance.now() - start;

    expectWithinBusyTimeout(elapsed, busyTimeout);
    release(holder);
  });

  it("#911 AC1: a lock held on a file not yet in WAL mode fails the whole open within the busy timeout, SQLite's own waits included", () => {
    const busyTimeout = 300;
    const holder = holdLocked(join(dir, "held-long.sqlite"));

    const start = performance.now();
    expect(() => openSqliteDatabase(join(dir, "held-long.sqlite"), busyTimeout)).toThrow(
      /database is locked/,
    );
    const elapsed = performance.now() - start;

    expectWithinBusyTimeout(elapsed, busyTimeout);
    release(holder);
  });

  it("#911: the busy timeout is set on the opened connection once the WAL switch is done", () => {
    const database = openSqliteDatabase(join(dir, "pragma.sqlite"), 1234);

    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    database.close();
  });
});
