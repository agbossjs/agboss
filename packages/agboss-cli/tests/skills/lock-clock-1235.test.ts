/**
 * #1235: a future-dated `seen-future` marker (the clock was ahead when it was written, then set
 * back) was never replaced, so the lock never aged out. These run with the real defaults
 * (waitMs 12 s, staleMs 10 min) on a fake clock: every `agboss check` is its own process (its
 * monotonic watch is forgotten), and ten minutes pass without waiting.
 */
import { lstatSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCK } from "../../src/skills/lock.js";
import type { LockClock } from "../../src/skills/lock-clock.js";
import { OWNER_PREFIX, newOwner, readHolder } from "../../src/skills/lock-owner.js";
import { SEEN_MARKER } from "../../src/skills/lock-files.js";
import { fingerprintOf, forgetObserved } from "../../src/skills/lock-watch.js";
import { syncSkills } from "../../src/skills/sync.js";
import { lockOf, noHome, oldProject, writeLock } from "./lock-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const { staleMs, waitMs } = DEFAULT_LOCK;
/** One check per minute: the wait, then a pause (a postinstall, a `dev` start). */
const EVERY = 51_000;
/** What a take-over may lag behind staleMs: a check's wait and the pause between two. */
const SLACK = waitMs + EVERY + 1_000;

/** A wall clock that can be stepped and a monotonic one that cannot; sleeping moves both. */
class FakeClock implements LockClock {
  private offset = 0;
  private monoMs = 1_000_000;
  readonly wall = (): number => Date.now() + this.offset;
  readonly mono = (): number => this.monoMs;
  readonly sleep = (ms: number): void => {
    this.offset += ms;
    this.monoMs += ms;
    this.stampKernel();
  };
  private folder: string | undefined;
  private stamped = 0;
  /**
   * The kernel stamps a folder with the real clock when an entry is made in it; on a real host that
   * is this clock. Here the folder of `lock`, changed behind our back, is stamped with this wall clock.
   */
  watch(lock: string): void {
    if (this.folder === lock) return;
    this.folder = lock;
    this.stamped = lstatSync(lock).mtimeMs;
  }
  private stampKernel(): void {
    if (this.folder === undefined) return;
    try {
      if (lstatSync(this.folder).mtimeMs === this.stamped) return;
      stamp(this.folder, this.wall());
      this.stamped = lstatSync(this.folder).mtimeMs;
    } catch {
      // the lock is gone
    }
  }
  /** Real time passes between two checks. */
  idle(ms: number): void {
    this.sleep(ms);
  }
  /** The wall clock is set `ms` forward (negative: back); the monotonic one does not notice. */
  step(ms: number): void {
    this.offset += ms;
  }
}

const check = (root: string, clock: FakeClock): boolean => {
  forgetObserved();
  clock.watch(lockOf(root));
  const done = syncSkills({ root, isEnabled: true }, "check", {
    ...noHome,
    lock: { ...DEFAULT_LOCK, clock },
  });
  return done.warnings.length === 0;
};

/** One check every minute until the lock is taken; the monotonic ms it took, undefined past `limitMs`. */
function untilTaken(
  root: string,
  clock: FakeClock,
  limitMs: number,
  every = EVERY,
): number | undefined {
  const start = clock.mono();
  while (clock.mono() - start <= limitMs) {
    if (check(root, clock)) return clock.mono() - start;
    clock.idle(every);
  }
  return undefined;
}

const stamp = (path: string, wallMs: number): void => {
  utimesSync(path, new Date(wallMs), new Date(wallMs));
};
const stampLock = (root: string, wallMs: number): void => {
  for (const name of readdirSync(lockOf(root))) stamp(join(lockOf(root), name), wallMs);
  stamp(lockOf(root), wallMs);
};
const markerOf = (root: string): string => join(lockOf(root), SEEN_MARKER);
const foreign = { host: "some-other-host" };

/** What a waiter left: the marker with the lock's fingerprint dated `markerAt`, then the folder dated `folderAt` (writing the marker touched it). */
function leaveMarker(root: string, markerAt: number, folderAt: number, mono?: number): void {
  const owner = readHolder(lockOf(root))?.token;
  const print = fingerprintOf(lockOf(root), owner);
  writeFileSync(markerOf(root), mono === undefined ? print : `${print}\n${String(mono)}`);
  stamp(markerOf(root), markerAt);
  stamp(lockOf(root), folderAt);
}

/** A lock of another host, its owner file and folder dated `wallMs`. */
function foreignLockAt(root: string, wallMs: number): void {
  writeLock(root, foreign);
  stampLock(root, wallMs);
}

describe(
  "#1235: the lock ages out staleMs after real time, whatever the clock did",
  { timeout: 120_000 },
  () => {
    it("a future-dated marker (old plain format) and a future lock: taken within staleMs, not before", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + 365 * 24 * HOUR);
      leaveMarker(root, clock.wall() + 365 * 24 * HOUR, clock.wall() + 365 * 24 * HOUR);

      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("the marker written by a check while the clock was ahead, the clock then set back by an hour", () => {
      const clock = new FakeClock();
      const root = oldProject();
      clock.step(3 * HOUR);
      foreignLockAt(root, clock.wall() + 10 * MIN);
      expect(check(root, clock)).toBe(false);
      const written = lstatSync(markerOf(root)).mtimeMs;
      expect(written).toBeGreaterThan(Date.now() + 2 * HOUR);

      clock.step(-3 * HOUR);
      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("a lock written on a clock that was ahead, the clock set back by more than staleMs", () => {
      const clock = new FakeClock();
      const root = oldProject();
      clock.step(2 * HOUR);
      foreignLockAt(root, clock.wall());
      expect(check(root, clock)).toBe(false);

      clock.step(-2 * HOUR);
      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("the clock jumping forward does not age the lock: only elapsed time does", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + HOUR);
      expect(check(root, clock)).toBe(false);

      clock.step(30 * MIN);
      expect(check(root, clock)).toBe(false);
      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs - 2 * SLACK);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("a marker whose mtime is in the future is rewritten to now at the first check", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + HOUR);
      leaveMarker(root, clock.wall() + 5 * HOUR, clock.wall() + HOUR);

      expect(check(root, clock)).toBe(false);

      expect(Math.abs(lstatSync(markerOf(root)).mtimeMs - clock.wall())).toBeLessThan(2 * waitMs);
    });

    it("a marker that is a minute ahead is a skew, not the future: it is kept as it is", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + HOUR);
      expect(check(root, clock)).toBe(false);
      const before = lstatSync(markerOf(root)).mtimeMs;
      stamp(markerOf(root), before + 30_000);

      expect(check(root, clock)).toBe(false);

      expect(lstatSync(markerOf(root)).mtimeMs).toBe(before + 30_000);
    });

    it("a marker from before a reboot (its monotonic time is ahead of this boot) starts the watch over", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + HOUR);
      leaveMarker(root, clock.wall() - 2 * staleMs, clock.wall() + HOUR, clock.mono() + 30 * HOUR);

      expect(check(root, clock)).toBe(false);
      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs - EVERY);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("a marker whose monotonic time is long ago but whose mtime is recent (a reboot, a longer uptime) is not old", () => {
      const clock = new FakeClock();
      const root = oldProject();
      foreignLockAt(root, clock.wall() + HOUR);
      leaveMarker(root, clock.wall() - 30_000, clock.wall() + HOUR, clock.mono() - 3 * staleMs);

      expect(check(root, clock)).toBe(false);
      const took = untilTaken(root, clock, staleMs + 3 * SLACK);

      expect(took).toBeGreaterThanOrEqual(staleMs - 2 * EVERY);
      expect(took).toBeLessThanOrEqual(staleMs + SLACK);
    });

    it("a live holder on this host whose start fits is never taken, however the clock jumps", () => {
      const clock = new FakeClock();
      const root = oldProject();
      const owner = writeLock(root, {});
      stampLock(root, clock.wall() + 365 * 24 * HOUR);
      for (const jump of [HOUR, -3 * HOUR, 5 * HOUR, -HOUR]) {
        clock.step(jump);
        clock.idle(HOUR);

        expect(check(root, clock)).toBe(false);
      }
      expect(readdirSync(lockOf(root))).toEqual([`${OWNER_PREFIX}${owner.token}`]);
    });

    it("a live pid whose start does not fit, a marker in the future: taken staleMs after, not at once", () => {
      const clock = new FakeClock();
      const root = oldProject();
      writeLock(root, { procStart: newOwner().procStart - HOUR }, 2 * MIN);
      stampLock(root, Date.now() - 2 * MIN);
      leaveMarker(root, clock.wall() + 2 * HOUR, clock.wall() - 2 * MIN);

      const took = untilTaken(root, clock, 2 * staleMs, 3 * MIN);

      expect(took).toBeGreaterThanOrEqual(staleMs);
      expect(took).toBeLessThanOrEqual(staleMs + waitMs + 3 * MIN + 1_000);
    });
  },
);
