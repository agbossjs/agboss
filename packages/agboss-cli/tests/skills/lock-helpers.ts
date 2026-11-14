import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_NAME } from "../../src/skills/lock.js";
import { OWNER_PREFIX, newOwner, type LockOwner } from "../../src/skills/lock-owner.js";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { syncSkills } from "../../src/skills/sync.js";

/** Helpers of the lock tests (#1013): projects, lock folders written by hand, child syncs. */
export const child = new URL("../fixtures/cli/skills-sync-child.ts", import.meta.url).pathname;
export const noHome = { home: (): undefined => undefined };
export const lockOf = (root: string): string => join(root, ".agents", LOCK_NAME);
export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A synced project whose copy says it was written by 0.1.0, so the next sync swaps the folder. */
export function oldProject(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-lock-"));
  syncSkills({ root, isEnabled: true }, "check", noHome);
  const copy = join(root, ".agents/skills/agboss");
  const files = readManifest(copy)?.files ?? {};
  writeFileSync(join(copy, MANIFEST_FILE), JSON.stringify({ version: "0.1.0", files }));
  return root;
}

/** A lock folder made by hand for `owner`, its file `ageMs` old. */
export function writeLock(root: string, owner: Partial<LockOwner>, ageMs = 0): LockOwner {
  const full = { ...newOwner(), ...owner };
  mkdirSync(lockOf(root), { recursive: true });
  const file = join(lockOf(root), `${OWNER_PREFIX}${full.token}`);
  writeFileSync(file, JSON.stringify(full));
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  return full;
}

/** A pid that was a process of this host and is gone. */
export function deadPid(): number {
  const run = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(run.stdout.toString());
}

export const thisHost = hostname();

export interface Ended {
  readonly lines: string[];
  readonly status: string;
  readonly signal: NodeJS.Signals | null;
}

/** A child sync, started now; `ended` resolves with what it printed and how it ended. */
export function startChild(
  root: string,
  mode: string,
  pauseMs = 0,
  startAt = 0,
): { run: ChildProcess; ended: Promise<Ended> } {
  const run = spawn(process.execPath, [
    "--import",
    "tsx",
    child,
    root,
    mode,
    String(startAt),
    String(pauseMs),
  ]);
  let out = "";
  run.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const ended = new Promise<Ended>((resolve, reject) => {
    run.on("error", reject);
    run.on("close", (_code, signal) => {
      const parsed = out === "" ? { lines: [], status: "" } : (JSON.parse(out) as Ended);
      resolve({ ...parsed, signal });
    });
  });
  return { run, ended };
}
