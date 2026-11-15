/**
 * #1013 re-acceptance fix-forward (#1105 #1106 #1107 #1108 and the guarantees no test protected):
 * a lock whose time lies in the future, a dead holder's lock with a stray entry, a link judged
 * by where the kernel leads it, a 0.1.x move refused for a linked `.claude`. Real files, real syncs.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCK } from "../../src/skills/lock.js";
import { OWNER_PREFIX, SEEN_MARKER, readHolder, sweepStray } from "../../src/skills/lock-owner.js";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { carryOver } from "../../src/skills/migrate.js";
import { SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import { deadPid, lockOf, noHome, oldProject, thisHost, writeLock } from "./lock-helpers.js";

const THIRTY_MIN = 30 * 60_000;
const quick = { waitMs: 300, staleMs: DEFAULT_LOCK.staleMs };
const syncQuick = (root: string) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, lock: quick });

const setTime = (path: string, offsetMs: number): void => {
  const when = new Date(Date.now() + offsetMs);
  utimesSync(path, when, when);
};

/** A project whose 0.1.0 skills stand at `.claude/skills/agboss/`, not yet moved. */
function legacyProject(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-1105-"));
  syncSkills({ root, isEnabled: true }, "check", noHome);
  const copy = join(root, ".agents/skills/agboss");
  const legacy = join(root, ".claude/skills/agboss");
  unlinkSync(legacy);
  renameSync(copy, legacy);
  const files = readManifest(legacy)?.files ?? {};
  writeFileSync(join(legacy, MANIFEST_FILE), JSON.stringify({ version: "0.1.0", files }));
  return root;
}

describe("#1105: a lock whose time is in the future ages out from when it was first seen, never at once", () => {
  const foreign = { host: "some-other-host" };
  const STALE = 800;
  const watching = { waitMs: 6_000, staleMs: STALE };
  const syncWith = (root: string, lock: { waitMs: number; staleMs: number }) =>
    syncSkills({ root, isEnabled: true }, "check", { ...noHome, lock });
  const YEAR = 365 * 86_400_000;
  const dateAll = (root: string, offsetMs: number): void => {
    for (const name of readdirSync(lockOf(root))) setTime(join(lockOf(root), name), offsetMs);
    setTime(lockOf(root), offsetMs);
  };

  it("another host's lock a year ahead is not taken before staleMs, and is taken after about staleMs", () => {
    const root = oldProject();
    writeLock(root, foreign);
    dateAll(root, YEAR);

    const early = syncWith(root, { waitMs: 300, staleMs: STALE });
    expect(early.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);

    const begun = performance.now();
    const done = syncWith(root, watching);
    const waited = performance.now() - begun;

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
    expect(waited).toBeLessThan(watching.waitMs);
    // the first sight was in the run before: what is left of staleMs is waited, not the year
    expect(waited).toBeGreaterThan(STALE - 700);
  });

  it("the monotonic first sight alone ages it out when the marker cannot help (dated ahead itself)", () => {
    const root = oldProject();
    writeLock(root, foreign);
    writeFileSync(join(lockOf(root), SEEN_MARKER), "");
    dateAll(root, YEAR);

    const begun = performance.now();
    const done = syncWith(root, watching);
    const waited = performance.now() - begun;

    expect(done.warnings).toEqual([]);
    expect(waited).toBeGreaterThanOrEqual(STALE - 100);
  });

  it("what an earlier run saw counts: a marker left staleMs ago ages the lock out in the first poll", () => {
    const root = oldProject();
    writeLock(root, foreign);
    writeFileSync(join(lockOf(root), SEEN_MARKER), "");
    dateAll(root, YEAR);
    setTime(join(lockOf(root), SEEN_MARKER), -2 * STALE);

    const done = syncWith(root, { waitMs: 300, staleMs: STALE });

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
  });

  it("an unreadable owner and a stray-file-only folder, a day ahead, age out the same way", () => {
    for (const make of ["garbage", "stray"]) {
      const root = oldProject();
      mkdirSync(lockOf(root), { recursive: true });
      if (make === "garbage") writeFileSync(join(lockOf(root), `${OWNER_PREFIX}gg`), "not json");
      else writeFileSync(join(lockOf(root), "stray"), "x");
      dateAll(root, 86_400_000);

      const begun = performance.now();
      const done = syncWith(root, watching);
      const waited = performance.now() - begun;

      expect(done.warnings).toEqual([]);
      expect(done.result.status).toBe(SkillsSyncStatus.Updated);
      expect(waited).toBeGreaterThanOrEqual(STALE - 100);
      expect(waited).toBeLessThan(watching.waitMs);
    }
  });

  it("a folder with no owner, a day ahead, is kept before staleMs: the age is not read off the disk", () => {
    const root = oldProject();
    mkdirSync(lockOf(root), { recursive: true });
    writeFileSync(join(lockOf(root), "stray"), "x");
    dateAll(root, 86_400_000);

    const done = syncWith(root, { waitMs: 300, staleMs: 60_000 });

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(existsSync(join(lockOf(root), "stray"))).toBe(true);
  });

  it("a dead owner on this host, a year ahead, is taken over at once", () => {
    const root = oldProject();
    writeLock(root, { pid: deadPid(), host: thisHost });
    dateAll(root, YEAR);

    const done = syncWith(root, { waitMs: 300, staleMs: 60_000 });

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
  });

  it("a small skew (30 s ahead) is not future: a fresh lock of another host is kept", () => {
    const root = oldProject();
    const owner = writeLock(root, foreign);
    setTime(join(lockOf(root), `${OWNER_PREFIX}${owner.token}`), 30_000);

    const done = syncQuick(root);

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(readHolder(lockOf(root))?.ageMs).toBeLessThan(DEFAULT_LOCK.staleMs);
  });

  it("a live holder on this host is kept indefinitely, whatever its time says, and nothing is written into its lock", () => {
    const root = oldProject();
    const owner = writeLock(root, {});
    dateAll(root, YEAR);

    const done = syncWith(root, { waitMs: 400, staleMs: 50 });

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(readdirSync(lockOf(root))).toEqual([`${OWNER_PREFIX}${owner.token}`]);
  });

  it("the clock stepped back while the holder holds: its start time reads as ahead, the live holder is kept", () => {
    const root = oldProject();
    // written on a clock one hour ahead of this one: the file's time and the start it records
    const ahead = Date.now() + 3_600_000;
    const owner = writeLock(root, { procStart: ahead });
    dateAll(root, 3_600_000);

    const done = syncWith(root, { waitMs: 400, staleMs: 50 });

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(existsSync(join(lockOf(root), `${OWNER_PREFIX}${owner.token}`))).toBe(true);
  });
});

describe("#1106: a dead holder's lock with a stray entry is taken over at once", () => {
  it("a dead owner plus .DS_Store and a folder, 30 minutes old: the first sync writes, the lock is gone", () => {
    const root = oldProject();
    writeLock(root, { pid: deadPid(), host: thisHost }, THIRTY_MIN);
    writeFileSync(join(lockOf(root), ".DS_Store"), "s");
    mkdirSync(join(lockOf(root), "zdir"));
    for (const name of readdirSync(lockOf(root))) setTime(join(lockOf(root), name), -THIRTY_MIN);
    setTime(lockOf(root), -THIRTY_MIN);

    const done = syncQuick(root);

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
    expect(existsSync(lockOf(root))).toBe(false);
  });

  it("a live owner with a stray entry keeps its lock and the stray", () => {
    const root = oldProject();
    writeLock(root, {}, THIRTY_MIN);
    writeFileSync(join(lockOf(root), ".DS_Store"), "s");
    setTime(lockOf(root), -THIRTY_MIN);

    const done = syncQuick(root);

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(existsSync(join(lockOf(root), ".DS_Store"))).toBe(true);
  });
});

describe("#1013 guarantees no test protected: what the lock's sweep and age keep", () => {
  it("sweepStray removes the stray entries and never an owner- file; a fresh lock keeps its folder", () => {
    const root = oldProject();
    const owner = writeLock(root, {});
    writeFileSync(join(lockOf(root), "stray"), "x");
    mkdirSync(join(lockOf(root), "zdir"));

    sweepStray(lockOf(root));

    expect(readdirSync(lockOf(root))).toEqual([`${OWNER_PREFIX}${owner.token}`]);
  });

  it("the folder's age counts: a fresh owner file in a 30-minute-old folder of another host is stale", () => {
    const root = oldProject();
    writeLock(root, { host: "some-other-host" });
    setTime(lockOf(root), -THIRTY_MIN);

    const done = syncQuick(root);

    expect(done.warnings).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
  });

  // Not tested, on purpose: an empty lock folder that is never cleared. On POSIX `rename` onto an
  // empty folder replaces it, so `clearEmpty` in `clearIfStale` changes nothing observable; the
  // difference exists on Windows only (a rename onto an existing folder fails there).
});

describe("#1107: a link is judged by where the kernel leads it", () => {
  /** A project with an outside folder, and `docs/symdir` linking to it. */
  function withSymdir(): { root: string; outside: string; copy: string } {
    const root = oldProject();
    const outside = mkdtempSync(join(tmpdir(), "agboss-out-"));
    mkdirSync(join(outside, "outdir"));
    writeFileSync(join(outside, "outdir/o.md"), "OUT");
    mkdirSync(join(root, "docs"));
    symlinkSync(join(outside, "outdir"), join(root, "docs/symdir"), "dir");
    return { root, outside, copy: join(root, ".agents/skills/agboss") };
  }

  it("a `..` after a link to an outside folder is dropped and named, as the plain form is", () => {
    const { root, copy } = withSymdir();
    symlinkSync("../../../docs/symdir/o.md", join(copy, "plain.md"));
    symlinkSync("../../../docs/symdir/../outdir/o.md", join(copy, "lexical-trick.md"));

    const done = syncQuick(root);

    for (const name of ["plain.md", "lexical-trick.md"]) {
      expect(lstatSync(join(copy, name), { throwIfNoEntry: false })).toBeUndefined();
      const text = done.warnings.map((w) => w.message).join("\n");
      expect(text).toMatch(new RegExp(`${name.replace(".", "\\.")} is a link that leaves`));
    }
  });

  it("a `..` after a link to a folder inside the project that lexically reads outside is kept", () => {
    const root = oldProject();
    const copy = join(root, ".agents/skills/agboss");
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    writeFileSync(join(root, "x.md"), "x");
    mkdirSync(join(root, "docs"));
    symlinkSync("../a/b/c", join(root, "docs/deep"), "dir");
    // docs/deep -> a/b/c; three `..` from there is the project root, `x.md` is inside
    symlinkSync("../../../docs/deep/../../../x.md", join(copy, "kept.md"));

    syncQuick(root);

    expect(readlinkSync(join(copy, "kept.md"))).toBe("../../../docs/deep/../../../x.md");
  });

  it("a loop of links is dropped, not followed forever", () => {
    const root = oldProject();
    const copy = join(root, ".agents/skills/agboss");
    symlinkSync("loop-b", join(root, "loop-a"));
    symlinkSync("loop-a", join(root, "loop-b"));
    symlinkSync("../../../loop-a", join(copy, "loop.md"));

    const done = syncQuick(root);

    expect(lstatSync(join(copy, "loop.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(done.warnings.map((w) => w.message).join("\n")).toMatch(
      /loop\.md is a link that leaves/,
    );
  });

  it("the same trick in a link carried by a 0.1.x move is not carried", () => {
    const root = legacyProject();
    const outside = mkdtempSync(join(tmpdir(), "agboss-out-"));
    mkdirSync(join(outside, "outdir"));
    mkdirSync(join(root, "docs"));
    symlinkSync(join(outside, "outdir"), join(root, "docs/symdir"), "dir");
    symlinkSync(
      "../../../docs/symdir/../outdir/o.md",
      join(root, ".claude/skills/agboss/lexical-trick.md"),
    );

    syncQuick(root);

    // moved: the old folder is now the link to the new one
    expect(lstatSync(join(root, ".claude/skills/agboss")).isSymbolicLink()).toBe(true);
    expect(
      lstatSync(join(root, ".agents/skills/agboss/lexical-trick.md"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });
});

describe("#1013 guarantees no test protected: the new place of a carried link, and equal links", () => {
  /** A project whose `.agents/skills` is a link to `a/`: the new folder is one level shallower. */
  function shallowNewPlace(): string {
    const root = legacyProject();
    writeFileSync(join(root, "x"), "x");
    // from `.claude/skills/agboss/` this is `<root>/x`; from `<root>/a/agboss/` it leaves the project
    symlinkSync("../../../x", join(root, ".claude/skills/agboss/l.md"));
    rmdirSync(join(root, ".agents/skills"));
    mkdirSync(join(root, "a"));
    symlinkSync("../a", join(root, ".agents/skills"), "dir");
    return root;
  }

  it("a fresh 0.1.x move does not write a link that leaves the project from its new place", () => {
    const root = shallowNewPlace();

    const done = syncQuick(root);

    expect(lstatSync(join(root, "a/agboss/l.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(
      done.warnings.some(
        (w) => w.code === SkillsWarningCode.UnmanagedFile && w.message.includes("l.md"),
      ),
    ).toBe(true);
  });

  it("carryOver alone re-checks the new place: a link that leaves from there is not created, and named", () => {
    const root = shallowNewPlace();
    const target = join(root, "a/agboss");
    mkdirSync(target);

    const warnings = carryOver(root, target, [
      { from: join(root, ".claude/skills/agboss/l.md"), path: "l.md", isLink: true },
    ]);

    expect(lstatSync(join(target, "l.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(warnings.map((w) => w.message).join("\n")).toMatch(
      /l\.md is a link that leaves the project from its new place/,
    );
  });

  it("two links of the same text are equal: no .legacy and no warning; other text gets .legacy", () => {
    const root = legacyProject();
    const target = join(root, ".agents/skills/agboss");
    mkdirSync(target, { recursive: true });
    const from = join(root, ".claude/skills/agboss");
    writeFileSync(join(root, "x"), "x");
    symlinkSync("../../../x", join(from, "same.md"));
    symlinkSync("../../../x", join(target, "same.md"));
    symlinkSync("../../../x", join(from, "other.md"));
    symlinkSync("../../../y", join(target, "other.md"));
    const kept = ["same.md", "other.md"].map((path) => ({
      from: join(from, path),
      path,
      isLink: true,
    }));

    const warnings = carryOver(root, target, kept);

    expect(readdirSync(target).filter((name) => name.endsWith(".legacy"))).toEqual([
      "other.md.legacy",
    ]);
    expect(warnings).toHaveLength(1);
  });
});

describe("#1108: a 0.1.x folder behind a linked .claude or .claude/skills: only the move is refused", () => {
  const variants: [string, (root: string) => void][] = [
    [
      ".claude",
      (root) => {
        mkdirSync(join(root, "inner"));
        renameSync(join(root, ".claude"), join(root, "inner/dotclaude"));
        symlinkSync("inner/dotclaude", join(root, ".claude"), "dir");
      },
    ],
    [
      ".claude/skills",
      (root) => {
        mkdirSync(join(root, "inner"));
        renameSync(join(root, ".claude/skills"), join(root, "inner/skills"));
        symlinkSync("../inner/skills", join(root, ".claude/skills"), "dir");
      },
    ],
  ];

  for (const [name, link] of variants) {
    it(`${name} linked inside the project: the warning says what is refused, .agents is still synced, the folder is untouched`, () => {
      const root = legacyProject();
      writeFileSync(join(root, ".claude/skills/agboss/mine.md"), "mine");
      link(root);

      for (let run = 0; run < 2; run += 1) {
        const done = syncQuick(root);

        const text = done.warnings.map((w) => w.message).join("\n");
        expect(text).toContain(`${name} is a link`);
        expect(text).toContain(".claude/skills/agboss/ is not moved");
        expect(text).not.toContain("inside the skills folder");
        expect(done.warnings.filter((w) => w.code === SkillsWarningCode.SyncFailed)).toEqual([]);
        expect(done.result.version).toBeDefined();
        expect(readManifest(join(root, ".agents/skills/agboss"))?.version).toBe(
          done.result.version,
        );
        expect(done.result.link).toBeUndefined();
        expect(existsSync(join(root, ".claude/skills/agboss/mine.md"))).toBe(true);
        expect(done.result.moved).toBeUndefined();
      }
    });
  }
});
