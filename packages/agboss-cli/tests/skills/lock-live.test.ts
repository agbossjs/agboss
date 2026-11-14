/**
 * #1013: the sync lock holds against a live holder however slow it is, a dead holder's lock is
 * taken at once, and only the lock's own holder releases it. Holders and waiters are processes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillsSyncStatus } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import {
  child,
  deadPid,
  lockOf,
  noHome,
  oldProject,
  sleepMs,
  startChild,
  thisHost,
  writeLock,
} from "./lock-helpers.js";

const sync = (root: string, lock?: { waitMs: number; staleMs: number }) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, ...(lock ? { lock } : {}) });

/** Waits until the holder is mid-swap: its lock is there and the copy's folder is not. */
async function untilMidSwap(root: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (existsSync(lockOf(root)) && !existsSync(join(root, ".agents/skills/agboss"))) return;
    await sleepMs(25);
  }
  throw new Error("the holder never reached the swap");
}

const warningsOf = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.startsWith("warning:"));

describe("#1013 AC1 AC5: a live holder keeps its lock", () => {
  it("AC1 AC5: a holder paused 15 s between its renames, default options: the waiter does not break it, the holder has no warning", async () => {
    const root = oldProject();
    const holder = startChild(root, "pause", 15_000);
    await untilMidSwap(root);

    const waiter = await startChild(root, "sync").ended;
    const held = await holder.ended;

    expect(warningsOf(held.lines)).toEqual([]);
    expect(held.status).toBe(SkillsSyncStatus.Updated);
    expect(warningsOf(waiter.lines)).toHaveLength(1);
    expect(waiter.lines.join("\n")).toContain("another agboss check holds");
    expect(sync(root).result.status).toBe(SkillsSyncStatus.Current);
    expect(readdirSync(join(root, ".agents")).sort()).toEqual(["skills"]);
  }, 90_000);

  it("AC1: a live owner for the whole wait: current says nothing, anything else one warning", () => {
    const root = oldProject();
    writeLock(root, {}, 0);
    expect(sync(root, { waitMs: 80, staleMs: 600_000 }).warnings).toHaveLength(1);

    const current = mkdtempSync(join(tmpdir(), "agboss-lock-"));
    sync(current);
    writeLock(current, {});
    const quiet = sync(current, { waitMs: 80, staleMs: 600_000 });
    expect(quiet.warnings).toEqual([]);
    expect(quiet.result.status).toBe(SkillsSyncStatus.Current);
    expect(existsSync(lockOf(current))).toBe(true);
  });
});

describe("#1013 AC2 AC4: a dead holder's lock", () => {
  it("AC2: a holder killed mid-swap: the next run takes the lock at once, no 12 s wait", () => {
    const root = oldProject();
    const killed = spawnSync(process.execPath, ["--import", "tsx", child, root, "kill"]);
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(lockOf(root))).toBe(true);

    // a wait of 300 ms (not the default 12 s): only a take-over by the dead pid finishes in it
    const done = sync(root, { waitMs: 300, staleMs: 600_000 });

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Current);
    expect(existsSync(lockOf(root))).toBe(false);
  });

  it("AC4: two waiters race on one dead holder's lock: both silent, one writes, one finds it current", async () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-lock-"));
    mkdirSync(join(root, ".agents"));
    writeLock(root, { pid: deadPid(), host: thisHost });
    const startAt = Date.now() + 1500;

    const both = await Promise.all([1, 2].map(() => startChild(root, "sync", 0, startAt).ended));

    expect(both.flatMap((one) => warningsOf(one.lines))).toEqual([]);
    expect(both.map((one) => one.status).sort()).toEqual(["current", "installed"]);
    expect(readdirSync(join(root, ".agents"))).toEqual(["skills"]);
  }, 30_000);
});

describe("#1013 AC2: Ctrl-C and another host", () => {
  it("AC2: SIGINT while the lock is held: the lock is released and the process dies of the signal", async () => {
    const root = oldProject();
    const holder = startChild(root, "pause", 3000);
    await untilMidSwap(root);

    holder.run.kill("SIGINT");
    const ended = await holder.ended;

    expect(ended.signal).toBe("SIGINT");
    expect(existsSync(lockOf(root))).toBe(false);
  }, 30_000);

  it("AC2: a lock of another host is taken only after the long bound", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-lock-"));
    writeLock(root, { host: "elsewhere", pid: deadPid() }, 60_000);
    const young = sync(root, { waitMs: 80, staleMs: 600_000 });
    expect(young.warnings).toHaveLength(1);
    expect(existsSync(lockOf(root))).toBe(true);

    const aged = mkdtempSync(join(tmpdir(), "agboss-lock-"));
    writeLock(aged, { host: "elsewhere", pid: deadPid() }, 11 * 60_000);
    const done = syncSkills({ root: aged, isEnabled: true }, "check", {
      ...noHome,
      lock: { waitMs: 2000, staleMs: 600_000 },
    });
    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Installed);
    expect(existsSync(lockOf(aged))).toBe(false);
  });
});
