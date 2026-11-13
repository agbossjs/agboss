/**
 * #983 acceptance fix-forward, D3: syncs of one project are serialised, so a `dev` pass beside
 * `npm install` prints no false `[skills.sync-failed]` / `[skills.link-failed]` for a state that
 * ends up correct.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_NAME } from "../../src/skills/lock.js";
import { LinkStatus, SkillsSyncStatus } from "../../src/skills/status.js";
import { linkClaudeSkills, REAL_LINK_OPS, type LinkOps } from "../../src/skills/link.js";
import { syncSkills } from "../../src/skills/sync.js";

const child = new URL("../fixtures/cli/skills-sync-child.ts", import.meta.url).pathname;
const noHome = { home: () => undefined };
const projectRoot = (): string => mkdtempSync(join(tmpdir(), "agboss-race-"));

/** One child sync: what it printed. */
function racer(root: string, startAt: number): Promise<{ lines: string[]; status: string }> {
  return new Promise((resolve, reject) => {
    const run = spawn(process.execPath, ["--import", "tsx", child, root, "sync", String(startAt)]);
    let out = "";
    run.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    run.on("error", reject);
    run.on("close", () => {
      resolve(JSON.parse(out) as { lines: string[]; status: string });
    });
  });
}

describe("#983 D3: concurrent syncs", () => {
  it("#983 D3: 3 concurrent syncs x 12 rounds: no warning, the end state is current", async () => {
    for (let round = 0; round < 12; round += 1) {
      const root = projectRoot();
      const startAt = Date.now() + 1500;

      const done = await Promise.all([1, 2, 3].map(() => racer(root, startAt)));

      expect(
        done.flatMap((one) => one.lines.filter((line) => line.startsWith("warning:"))),
      ).toEqual([]);
      const after = syncSkills({ root, isEnabled: true }, "check", noHome);
      expect(after.result.status).toBe(SkillsSyncStatus.Current);
      expect(after.result.link?.status).toBe(LinkStatus.Current);
      expect(readdirSync(join(root, ".agents")).filter((name) => name.includes("-old"))).toEqual(
        [],
      );
    }
  }, 120_000);

  it("#983 D3: a lock held by a live sync for the whole wait: end state current, silent; not current, one warning", () => {
    const root = projectRoot();
    syncSkills({ root, isEnabled: true }, "check", noHome);
    mkdirSync(join(root, ".agents", LOCK_NAME));

    const current = syncSkills({ root, isEnabled: true }, "check", {
      ...noHome,
      lock: { waitMs: 60, staleMs: 60_000 },
    });

    expect(current.warnings).toEqual([]);
    expect(current.result.status).toBe(SkillsSyncStatus.Current);

    const fresh = projectRoot();
    mkdirSync(join(fresh, ".agents", LOCK_NAME), { recursive: true });
    const skipped = syncSkills({ root: fresh, isEnabled: true }, "check", {
      ...noHome,
      lock: { waitMs: 60, staleMs: 60_000 },
    });
    expect(skipped.warnings).toHaveLength(1);
    expect(readdirSync(join(fresh, ".agents"))).toEqual([LOCK_NAME]);
  });

  it("#983 D3: the lock of a killed holder is stale after a bound and taken over; the lock is released after a sync", () => {
    const root = projectRoot();
    const lock = join(root, ".agents", LOCK_NAME);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const done = syncSkills({ root, isEnabled: true }, "check", {
      ...noHome,
      lock: { waitMs: 2000, staleMs: 10_000 },
    });

    expect(done.result.status).toBe(SkillsSyncStatus.Installed);
    expect(readdirSync(join(root, ".agents"))).toEqual(["skills"]);
  });

  it("#983 D3: EEXIST at the link, the link is right now: current, no warning", () => {
    const root = projectRoot();
    syncSkills({ root, isEnabled: true }, "check", noHome);
    const racing: LinkOps = {
      ...REAL_LINK_OPS,
      // the loser: its lstat saw nothing, another run made the link before its symlink
      lstat: () => undefined,
      symlink: () => {
        throw Object.assign(new Error("EEXIST: file already exists, symlink"), { code: "EEXIST" });
      },
    };

    const done = linkClaudeSkills(root, racing);

    expect(done).toEqual({ status: LinkStatus.Current, warnings: [] });
  });

  it("#983 D3: EEXIST with something else in the way stays a warning", () => {
    const root = projectRoot();
    syncSkills({ root, isEnabled: true }, "check", noHome);
    const other = join(root, "other");
    mkdirSync(other);
    const link = join(root, ".claude/skills/agboss");
    unlinkSync(link);
    symlinkSync(other, link, "dir");
    const racing: LinkOps = {
      ...REAL_LINK_OPS,
      lstat: () => undefined,
      symlink: () => {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      },
    };

    expect(linkClaudeSkills(root, racing).status).toBe(LinkStatus.Failed);
  });
});
