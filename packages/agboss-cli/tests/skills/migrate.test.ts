/**
 * #983 AC2: a 0.1.x project (a real `.claude/skills/agboss/` with a manifest, maybe a file of the
 * project's own) moves to `.agents/skills/agboss/` on the next sync: one warning, the own file kept,
 * the old path a link. A crash between the swap and the removal finishes on the next run.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../src/skills/replace.js";
import { cliSkillsSource } from "../../src/skills/source.js";
import { LinkStatus, SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { skillsLines, syncSkills } from "../../src/skills/sync.js";

const REFERENCE = "references/02-flow-dsl-all-combinations.md";
const version = cliSkillsSource()?.version ?? "";
const noHome = { home: () => undefined };

const copyOf = (root: string): string => join(root, ".agents/skills/agboss");
const legacyOf = (root: string): string => join(root, ".claude/skills/agboss");
const sync = (root: string, replace?: ReplaceOps) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, ...(replace ? { replace } : {}) });

/** Syncs, then turns the result into what 0.1.x wrote: the real folder at `.claude/skills/agboss`. */
function asLegacy(root: string): void {
  sync(root);
  unlinkSync(legacyOf(root));
  renameSync(copyOf(root), legacyOf(root));
}

/**
 * A project as 0.1.0 left it: the skills in `.claude/skills/agboss/` under a 0.1.0 manifest, with an
 * unmanaged `notes.md` and an edited reference.
 */
function legacyProject(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-migrate-"));
  asLegacy(root);
  const manifest = readManifest(legacyOf(root));
  writeFileSync(
    join(legacyOf(root), MANIFEST_FILE),
    JSON.stringify({ version: "0.1.0", files: manifest?.files ?? {} }),
  );
  writeFileSync(join(legacyOf(root), "notes.md"), "my notes");
  appendFileSync(join(legacyOf(root), REFERENCE), "\nmy own rule\n");
  return root;
}

/** A replace whose `rm` fails for the old folder only, as a crash after the swap would. */
const crashOnLegacy = (root: string): ReplaceOps => ({
  ...REAL_REPLACE_OPS,
  rm: (path) => {
    if (path === legacyOf(root)) throw new Error("EBUSY: crash before the removal");
    REAL_REPLACE_OPS.rm(path);
  },
});

describe("#983 AC2: a 0.1.x project is moved", () => {
  it("AC2: legacy folder moved, own file kept, link made — [skills.moved], [skills.unmanaged-file], [skills.local-edit]", () => {
    const root = legacyProject();

    const done = sync(root);

    expect(done.result).toMatchObject({
      status: SkillsSyncStatus.Updated,
      previous: "0.1.0",
      version,
      folder: ".agents/skills/agboss",
      moved: { from: ".claude/skills/agboss" },
      link: { path: ".claude/skills/agboss", status: LinkStatus.Linked },
    });
    expect(done.warnings.map((warning) => warning.code).sort()).toEqual(
      [
        SkillsWarningCode.LocalEdit,
        SkillsWarningCode.Moved,
        SkillsWarningCode.UnmanagedFile,
      ].sort(),
    );
    expect(done.warnings.find((w) => w.code === SkillsWarningCode.Moved)?.message).toBe(
      '.claude/skills/agboss/ moved to .agents/skills/agboss/ (one copy for every coding agent): commit .agents/skills/agboss/; .claude/skills/agboss is now a local link to it — in .gitignore replace the old ".claude/skills/agboss/" line with ".claude/skills/agboss" (no trailing slash)',
    );
    expect(readFileSync(join(copyOf(root), "notes.md"), "utf8")).toBe("my notes");
    expect(readFileSync(join(copyOf(root), REFERENCE), "utf8")).not.toContain("my own rule");
    expect(lstatSync(legacyOf(root)).isSymbolicLink()).toBe(true);
    // the old paths in AGENTS.md open the same files, once on disk
    expect(readFileSync(join(legacyOf(root), "SKILL.md"), "utf8")).toBe(
      readFileSync(join(copyOf(root), "SKILL.md"), "utf8"),
    );
    expect(realpathSync(join(legacyOf(root), "notes.md"))).toBe(
      realpathSync(join(copyOf(root), "notes.md")),
    );
    expect(readdirSync(join(root, ".agents"))).toEqual(["skills"]);
    expect(skillsLines(done).at(-1)).toBe(
      `skills: .agents/skills/agboss updated 0.1.0 → ${version} (14 files) · linked .claude/skills/agboss`,
    );
  });

  it("AC2: a legacy folder already at the installed version is moved too (installed, all files written)", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-migrate-"));
    asLegacy(root);

    const done = sync(root);

    expect(done.result).toMatchObject({ status: SkillsSyncStatus.Installed, moved: {} });
    expect(done.result.written).toHaveLength(14);
    expect(existsSync(join(copyOf(root), "SKILL.md"))).toBe(true);
  });

  it("AC2: interrupted migration finishes — the removal throws after the swap, the next run completes", () => {
    const root = legacyProject();

    const crashed = sync(root, crashOnLegacy(root));

    expect(crashed.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([SkillsWarningCode.SyncFailed]),
    );
    expect(crashed.warnings.map((w) => w.code)).not.toContain(SkillsWarningCode.Moved);
    expect(crashed.result.moved).toBeUndefined();
    expect(crashed.result.link).toBeUndefined();
    expect(lstatSync(legacyOf(root)).isDirectory()).toBe(true);
    expect(readManifest(copyOf(root))?.version).toBe(version);

    const finished = sync(root);

    expect(finished.warnings.map((w) => w.code)).toContain(SkillsWarningCode.Moved);
    expect(finished.result).toMatchObject({
      moved: { from: ".claude/skills/agboss" },
      link: { status: LinkStatus.Linked },
    });
    expect(lstatSync(legacyOf(root)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(copyOf(root), "notes.md"), "utf8")).toBe("my notes");
  });

  it("AC2: both managed, the legacy one with nothing of the project's: it is removed, .agents wins", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-migrate-"));
    sync(root);
    unlinkSync(legacyOf(root));
    mkdirSync(legacyOf(root), { recursive: true });
    writeFileSync(join(legacyOf(root), MANIFEST_FILE), '{ "version": "0.1.0", "files": {} }');
    writeFileSync(join(copyOf(root), "own.md"), "in the new folder");

    const done = sync(root);

    expect(lstatSync(legacyOf(root)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(copyOf(root), "own.md"), "utf8")).toBe("in the new folder");
    expect(done.result.status).toBe(SkillsSyncStatus.Current);
    expect(done.warnings.map((w) => w.code)).toContain(SkillsWarningCode.Moved);
  });

  it("AC2: both managed, the legacy one with an own file: it is moved into .agents (not over a file there)", () => {
    const root = legacyProject();
    sync(root, crashOnLegacy(root));
    writeFileSync(join(copyOf(root), "notes.md"), "newer notes in .agents");
    writeFileSync(join(legacyOf(root), "more.md"), "more");

    const done = sync(root);

    expect(readFileSync(join(copyOf(root), "notes.md"), "utf8")).toBe("newer notes in .agents");
    expect(readFileSync(join(copyOf(root), "more.md"), "utf8")).toBe("more");
    expect(done.warnings.map((w) => w.code)).toContain(SkillsWarningCode.UnmanagedFile);
    expect(lstatSync(legacyOf(root)).isSymbolicLink()).toBe(true);
  });

  it("AC6: a legacy folder without a manifest is the user's: not touched, [skills.link-blocked], the copy still written", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-migrate-"));
    mkdirSync(legacyOf(root), { recursive: true });
    writeFileSync(join(legacyOf(root), "SKILL.md"), "mine");

    const done = sync(root);

    expect(readFileSync(join(legacyOf(root), "SKILL.md"), "utf8")).toBe("mine");
    expect(readdirSync(legacyOf(root))).toEqual(["SKILL.md"]);
    expect(done.result).toMatchObject({
      status: SkillsSyncStatus.Installed,
      link: { status: LinkStatus.Blocked },
    });
    expect(done.warnings.map((w) => w.code)).toEqual([SkillsWarningCode.LinkBlocked]);
    expect(existsSync(join(copyOf(root), "SKILL.md"))).toBe(true);
  });
});
