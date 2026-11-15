/**
 * #1105 security: a cloned project can ship the lock folder, its owner file or its marker as a link
 * to a file outside the project (`~/.bashrc`). Nothing is written, touched or followed through it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSyncLock } from "../../src/skills/lock.js";
import { SEEN_MARKER } from "../../src/skills/lock-files.js";
import { OWNER_PREFIX } from "../../src/skills/lock-owner.js";
import { fingerprintOf, renewOwner } from "../../src/skills/lock-watch.js";
import { SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import { lockOf, noHome, oldProject, writeLock } from "./lock-helpers.js";

const LONG_AGO = new Date("2001-02-03T04:05:06Z");
const YEAR = 365 * 86_400_000;

/** A file outside the project, its bytes and its time known: what a write through a link would change. */
function outsideFile(): { path: string; unchanged: () => boolean } {
  const path = join(mkdtempSync(join(tmpdir(), "agboss-outside-")), "bashrc");
  writeFileSync(path, "export SECRET=1\n");
  utimesSync(path, LONG_AGO, LONG_AGO);
  return {
    path,
    unchanged: () =>
      readFileSync(path, "utf8") === "export SECRET=1\n" &&
      lstatSync(path).mtimeMs === LONG_AGO.getTime(),
  };
}

const sync = (root: string, lock = { waitMs: 300, staleMs: 60_000 }) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, lock });

const isLink = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/** Dates every entry of the lock folder, and the folder, far ahead: the waiter must watch it. */
const dateAhead = (root: string): void => {
  const when = new Date(Date.now() + YEAR);
  for (const name of readdirSync(lockOf(root))) utimesSync(join(lockOf(root), name), when, when);
  utimesSync(lockOf(root), when, when);
};

describe("#1105 security: the lock folder's entries are never written through a link", () => {
  it("the marker as a link to a file outside: the file keeps its bytes and its time, the link is replaced", () => {
    const outside = outsideFile();
    for (const mode of ["future", "reused"]) {
      const root = oldProject();
      if (mode === "future") writeLock(root, { host: "some-other-host" });
      else writeLock(root, { procStart: 1 }, 600_000);
      if (mode === "future") dateAhead(root);
      symlinkSync(outside.path, join(lockOf(root), SEEN_MARKER));

      sync(root);

      expect(outside.unchanged()).toBe(true);
      expect(isLink(join(lockOf(root), SEEN_MARKER))).toBe(false);
    }
  });

  it("the owner file as a link to a file outside: not followed, removed itself", () => {
    const outside = outsideFile();
    const root = oldProject();
    mkdirSync(lockOf(root), { recursive: true });
    symlinkSync(outside.path, join(lockOf(root), `${OWNER_PREFIX}evil`));

    sync(root);

    expect(outside.unchanged()).toBe(true);
    expect(isLink(join(lockOf(root), `${OWNER_PREFIX}evil`))).toBe(false);
  });

  it("a holder's renew finds its owner file replaced by a link: the file outside is not touched, the link goes", () => {
    const outside = outsideFile();
    const root = oldProject();
    let file = "";
    withSyncLock(root, (renew) => {
      file = join(lockOf(root), readdirSync(lockOf(root))[0] ?? "");
      unlinkSync(file);
      symlinkSync(outside.path, file);
      renew();
    });

    expect(outside.unchanged()).toBe(true);
    expect(isLink(file)).toBe(false);
  });

  it("renewOwner called on a link directly leaves the file outside alone", () => {
    const outside = outsideFile();
    const root = oldProject();
    mkdirSync(lockOf(root), { recursive: true });
    symlinkSync(outside.path, join(lockOf(root), `${OWNER_PREFIX}abc`));

    renewOwner(lockOf(root), "abc");

    expect(outside.unchanged()).toBe(true);
  });

  it("the fingerprint of a link owner is read without following it", () => {
    const outside = outsideFile();
    const root = oldProject();
    mkdirSync(lockOf(root), { recursive: true });
    symlinkSync(outside.path, join(lockOf(root), `${OWNER_PREFIX}abc`));

    expect(fingerprintOf(lockOf(root), "abc")).not.toBe(String(LONG_AGO.getTime()));
  });
});

describe("#1105 security: a lock folder that is a link is refused", () => {
  it("nothing is written through it: the folder it leads to stays empty, the link stays, the sync says why", () => {
    const root = oldProject();
    const elsewhere = mkdtempSync(join(tmpdir(), "agboss-elsewhere-"));
    rmSync(lockOf(root), { recursive: true, force: true });
    symlinkSync(elsewhere, lockOf(root), "dir");

    const done = sync(root);

    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.SyncFailed]);
    expect(done.warnings[0]?.message).toMatch(/is a link/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(isLink(lockOf(root))).toBe(true);
    expect(existsSync(join(elsewhere, "x"))).toBe(false);
  });
});
