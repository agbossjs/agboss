/**
 * #1013 acceptance fix-forward (#1075 and the guarantees no test protected): an owner nobody can
 * read ages out by its age on disk, a crashed lock's scratch folder is swept, and the lock's bounds,
 * its pid-reuse tolerance and its take-over's non-recursive removal hold. Real files, real syncs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCK, LOCK_NAME, withSyncLock } from "../../src/skills/lock.js";
import {
  OWNER_PREFIX,
  clearEmpty,
  isStale,
  newOwner,
  readHolder,
} from "../../src/skills/lock-owner.js";
import { SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import { lockOf, noHome, oldProject, writeLock } from "./lock-helpers.js";

const THIRTY_MIN = 30 * 60_000;
const quick = { waitMs: 300, staleMs: DEFAULT_LOCK.staleMs };
const syncQuick = (root: string) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, lock: quick });

const ageIt = (path: string, ageMs: number): void => {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
};

describe("#1075 AC2: an owner nobody can read ages out by its mtime", () => {
  const unreadable: [string, (file: string) => void][] = [
    [
      "garbage",
      (file) => {
        writeFileSync(file, "not json");
      },
    ],
    [
      "empty",
      (file) => {
        writeFileSync(file, "");
      },
    ],
    [
      "mode 000",
      (file) => {
        writeFileSync(file, "{}");
        chmodSync(file, 0);
      },
    ],
  ];

  for (const [name, make] of unreadable) {
    it(`#1075: a ${name} owner file 30 minutes old is taken over and the sync writes`, () => {
      const root = oldProject();
      mkdirSync(lockOf(root), { recursive: true });
      const file = join(lockOf(root), `${OWNER_PREFIX}eeee`);
      make(file);
      ageIt(file, THIRTY_MIN);

      const done = syncQuick(root);

      expect(done.warnings).toEqual([]);
      expect(done.result.status).toBe(SkillsSyncStatus.Updated);
      expect(existsSync(lockOf(root))).toBe(false);
    });

    it(`#1075: a ${name} owner file that is fresh is not taken over`, () => {
      const root = oldProject();
      mkdirSync(lockOf(root), { recursive: true });
      make(join(lockOf(root), `${OWNER_PREFIX}eeee`));

      const done = syncQuick(root);

      expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
      expect(existsSync(lockOf(root))).toBe(true);
    });
  }

  it("#1075: a lock folder holding only some other file ages out by the folder's mtime", () => {
    const root = oldProject();
    mkdirSync(join(lockOf(root), "owner"), { recursive: true });
    writeFileSync(join(lockOf(root), "owner", "pre-1013"), "x");
    const fresh = syncQuick(root);
    expect(fresh.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);

    ageIt(lockOf(root), THIRTY_MIN);
    const done = syncQuick(root);

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
    expect(existsSync(lockOf(root))).toBe(false);
  });

  it("AC2: the unreadable owner's age is read from the disk, not assumed", () => {
    const root = oldProject();
    mkdirSync(lockOf(root), { recursive: true });
    const file = join(lockOf(root), `${OWNER_PREFIX}zz`);
    writeFileSync(file, "garbage");
    ageIt(file, THIRTY_MIN);
    ageIt(lockOf(root), THIRTY_MIN);

    const holder = readHolder(lockOf(root));

    expect(holder?.owner).toBeUndefined();
    expect(holder?.ageMs).toBeGreaterThan(THIRTY_MIN - 60_000);
    expect(holder?.ageMs).toBeLessThan(THIRTY_MIN + 60_000);
  });

  it("#1075: a scratch `-new-` folder of a crashed lock is removed when older than staleMs, a fresh one stays", () => {
    const root = oldProject();
    const crashed = join(root, ".agents", `${LOCK_NAME}-new-aaaa`);
    const fresh = join(root, ".agents", `${LOCK_NAME}-new-bbbb`);
    mkdirSync(crashed);
    mkdirSync(fresh);
    writeFileSync(join(crashed, `${OWNER_PREFIX}x`), "{}");
    ageIt(crashed, THIRTY_MIN);

    syncQuick(root);

    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("#1013 AC2: the pid-reuse tolerance is 5 s", () => {
  const withStart = (offsetMs: number) => {
    const owner = newOwner();
    return { ...owner, procStart: owner.procStart - offsetMs };
  };
  const old = 120_000;

  it("AC2: a start time 3 s off the live process' is the same process; 8 s off is a reused pid", () => {
    const near = withStart(3_000);
    const far = withStart(8_000);
    expect(isStale({ token: near.token, owner: near, ageMs: old }, 600_000)).toBe(false);
    expect(isStale({ token: far.token, owner: far, ageMs: old }, 600_000)).toBe(true);
  });
});

describe("#1013 AC5: the defaults", () => {
  it("AC5: a waiter waits 12 s and a lock of an unknown owner is stale after 10 minutes", () => {
    expect(DEFAULT_LOCK).toEqual({ waitMs: 12_000, staleMs: 600_000 });
  });
});

describe("#1013 AC4: the take-over's last step is non-recursive", () => {
  it("AC4: clearing a folder that holds a fresh lock leaves it and its owner file", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-clear-"));
    const fresh = writeLock(root, {});

    clearEmpty(lockOf(root));

    expect(existsSync(join(lockOf(root), `${OWNER_PREFIX}${fresh.token}`))).toBe(true);
  });

  it("AC2: an empty lock folder is cleared", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-clear-"));
    mkdirSync(lockOf(root), { recursive: true });

    clearEmpty(lockOf(root));

    expect(existsSync(lockOf(root))).toBe(false);
    expect(withSyncLock(root, () => 1, quick)).toEqual({ value: 1 });
  });
});
