/**
 * #911: N application instances starting at the same moment on one brand-new SQLite file all
 * start. The WAL switch of a fresh file can answer "database is locked" at once, whatever the busy
 * timeout — `openSqliteDatabase` retries it, bounded by the busy timeout, never a fixed sleep.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("#911: a new SQLite file opened by several processes at once", () => {
  it("#911 AC1: every process opens it and creates its tables, round after round", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const results = await openTogether(join(dir, `round-${String(round)}`, "app.sqlite"));

      expect(results).toEqual(Array.from({ length: PROCESSES }, () => "opened"));
    }
  }, 120_000);

  it("#911 AC1: a file another connection holds locked still fails once the busy timeout is spent", () => {
    const path = join(dir, "held.sqlite");
    const holder = openSqliteDatabase(path, 50);
    holder.exec("PRAGMA journal_mode = DELETE");
    holder.exec("CREATE TABLE held (id INTEGER); BEGIN EXCLUSIVE");

    expect(() => openSqliteDatabase(path, 50)).toThrow(/database is locked/);

    holder.exec("ROLLBACK");
    holder.close();
  });
});
