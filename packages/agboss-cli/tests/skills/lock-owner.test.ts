/** #1013: who owns the lock, when it is stale, and that a take-over or a release hits only its own. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSyncLock } from "../../src/skills/lock.js";
import {
  OWNER_PREFIX,
  dropOwner,
  isStale,
  newOwner,
  readHolder,
} from "../../src/skills/lock-owner.js";
import { deadPid, lockOf, thisHost, writeLock } from "./lock-helpers.js";

const projectRoot = (): string => mkdtempSync(join(tmpdir(), "agboss-owner-"));

describe("#1013 AC2: when a lock is stale", () => {
  it("AC2: a dead pid on this host is stale at once; a live one is not, however old", () => {
    const root = projectRoot();
    const dead = writeLock(root, { pid: deadPid(), host: thisHost });
    expect(isStale({ token: dead.token, owner: dead, ageMs: 0 }, 600_000)).toBe(true);

    const live = newOwner();
    expect(isStale({ token: live.token, owner: live, ageMs: 5_000 }, 600_000)).toBe(false);
  });

  it("AC2: pid reuse — the pid lives but started long after the lock was made", () => {
    const reused = { ...newOwner(), procStart: Date.now() - 3_600_000 };
    expect(isStale({ token: reused.token, owner: reused, ageMs: 120_000 }, 600_000)).toBe(true);
    expect(isStale({ token: reused.token, owner: reused, ageMs: 1_000 }, 600_000)).toBe(false);
  });

  it("AC2: another host or an unreadable owner ages out by the long bound only", () => {
    const foreign = { ...newOwner(), host: "elsewhere" };
    expect(isStale({ token: "a", owner: foreign, ageMs: 599_000 }, 600_000)).toBe(false);
    expect(isStale({ token: "a", owner: foreign, ageMs: 601_000 }, 600_000)).toBe(true);
    expect(isStale({ token: "b", owner: undefined, ageMs: 10_000 }, 600_000)).toBe(false);
    expect(isStale({ token: "b", owner: undefined, ageMs: 601_000 }, 600_000)).toBe(true);
  });

  it("AC2: a garbage owner file reads as unreadable, a folder with none as empty", () => {
    const root = projectRoot();
    mkdirSync(lockOf(root), { recursive: true });
    expect(readHolder(lockOf(root))).toMatchObject({ token: undefined });
    writeFileSync(join(lockOf(root), `${OWNER_PREFIX}zz`), "not json");
    expect(readHolder(lockOf(root))).toMatchObject({ token: "zz", owner: undefined });
    expect(readHolder(join(root, "nothing"))).toBeUndefined();
  });
});

describe("#1013 AC3 AC4: only the lock's own token is touched", () => {
  it("AC4: two take-overs of one stale lock: exactly one wins", () => {
    const root = projectRoot();
    const stale = writeLock(root, { pid: deadPid(), host: thisHost });

    expect([dropOwner(lockOf(root), stale.token), dropOwner(lockOf(root), stale.token)]).toEqual([
      true,
      false,
    ]);
    expect(existsSync(lockOf(root))).toBe(false);
  });

  it("AC4: a take-over that saw the old lock never removes the fresh one made after it", () => {
    const root = projectRoot();
    const old = writeLock(root, { pid: deadPid(), host: thisHost });
    rmSync(lockOf(root), { recursive: true });
    const fresh = writeLock(root, {});

    expect(dropOwner(lockOf(root), old.token)).toBe(false);

    expect(readdirSync(lockOf(root))).toEqual([`${OWNER_PREFIX}${fresh.token}`]);
  });

  it("AC3: a holder whose lock was taken leaves the next holder's lock alone", () => {
    const root = projectRoot();
    let other = "";

    const done = withSyncLock(root, () => {
      rmSync(lockOf(root), { recursive: true });
      other = writeLock(root, {}).token;
      return 1;
    });

    expect(done).toEqual({ value: 1 });
    expect(readdirSync(lockOf(root))).toEqual([`${OWNER_PREFIX}${other}`]);
  });

  it("AC3: a released lock is gone, with no folder left in .agents", () => {
    const root = projectRoot();
    withSyncLock(root, () => 1);
    expect(readdirSync(join(root, ".agents"))).toEqual([]);
  });
});
