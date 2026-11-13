/**
 * #983 (security): a parent folder of the skills that is a symlink leaving the project — a cloned
 * repository shipping `.claude -> ~` or `.agents -> /somewhere` — must not make the sync write,
 * move, remove or link outside it. Each of the four parents, as an outside link: the outside folder
 * stays byte-identical, a warning is given, nothing is touched. A link that stays inside is fine.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkClaudeSkills } from "../../src/skills/link.js";
import { MANIFEST_FILE } from "../../src/skills/manifest.js";
import { LinkStatus, SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";

/** Every file under `dir` with its bytes: what must not change. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(dir.length)] = readFileSync(path, "utf8");
    }
  return files;
}

/**
 * An outside folder shaped like what the sync touches: a managed 0.1.x skill, a leftover idle for
 * an hour, and a file of its own.
 */
function outsideFolder(): string {
  const outside = mkdtempSync(join(tmpdir(), "agboss-outside-"));
  mkdirSync(join(outside, "skills/agboss"), { recursive: true });
  mkdirSync(join(outside, "agboss"), { recursive: true });
  for (const skill of [join(outside, "skills/agboss"), join(outside, "agboss")]) {
    writeFileSync(join(skill, MANIFEST_FILE), '{ "version": "0.1.0", "files": {} }');
    writeFileSync(join(skill, "notes.md"), "not the project's");
  }
  const leftover = join(outside, ".agboss-skills-deadbeef");
  mkdirSync(leftover);
  writeFileSync(join(leftover, "x"), "x");
  utimesSync(leftover, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const nested = join(outside, "skills/.agboss-skills-deadbeef");
  mkdirSync(nested);
  utimesSync(nested, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  writeFileSync(join(outside, "SECRET"), "do not touch");
  return outside;
}

const PARENTS = [".claude", ".claude/skills", ".agents", ".agents/skills"];

describe("#983: a symlinked parent that leaves the project is refused", () => {
  for (const parent of PARENTS)
    it(`${parent} -> outside: the sync touches nothing outside and warns [skills.outside-project]`, () => {
      const root = mkdtempSync(join(tmpdir(), "agboss-contain-"));
      const outside = outsideFolder();
      const before = snapshot(outside);
      mkdirSync(join(root, parent, ".."), { recursive: true });
      symlinkSync(outside, join(root, parent), "dir");

      const done = syncSkills({ root, isEnabled: true }, "check", { home: () => undefined });

      expect(done.result.status).toBe(SkillsSyncStatus.Failed);
      expect(done.warnings.map((warning) => warning.code)).toEqual([
        SkillsWarningCode.OutsideProject,
      ]);
      expect(done.warnings[0]?.message).toContain(`${parent} is a link that leaves the project`);
      expect(snapshot(outside)).toEqual(before);
      expect(readdirSync(outside).sort()).toEqual(
        [".agboss-skills-deadbeef", "SECRET", "agboss", "skills"].sort(),
      );
      expect(readdirSync(join(outside, "skills")).sort()).toEqual([
        ".agboss-skills-deadbeef",
        "agboss",
      ]);
      expect(lstatSync(join(root, parent)).isSymbolicLink()).toBe(true);
    });

  for (const parent of [".claude", ".claude/skills"])
    it(`${parent} -> outside: agboss create's link step makes no link outside`, () => {
      const root = mkdtempSync(join(tmpdir(), "agboss-contain-"));
      const outside = outsideFolder();
      const before = snapshot(outside);
      mkdirSync(join(root, ".agents/skills/agboss"), { recursive: true });
      mkdirSync(join(root, parent, ".."), { recursive: true });
      symlinkSync(outside, join(root, parent), "dir");

      const done = linkClaudeSkills(root);

      expect(done.status).toBe(LinkStatus.Blocked);
      expect(done.warnings.map((warning) => warning.code)).toEqual([
        SkillsWarningCode.OutsideProject,
      ]);
      expect(snapshot(outside)).toEqual(before);
      expect(readdirSync(outside).sort()).toEqual(
        [".agboss-skills-deadbeef", "SECRET", "agboss", "skills"].sort(),
      );
    });

  it(".agents/skills/agboss itself a link out: refused too, the target's files are not read into the project", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-contain-"));
    const outside = outsideFolder();
    const before = snapshot(outside);
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    symlinkSync(join(outside, "agboss"), join(root, ".agents/skills/agboss"), "dir");

    const done = syncSkills({ root, isEnabled: true }, "check", { home: () => undefined });

    expect(done.warnings.map((warning) => warning.code)).toEqual([
      SkillsWarningCode.OutsideProject,
    ]);
    expect(snapshot(outside)).toEqual(before);
  });

  it("a dangling link as a parent is refused too: mkdir -p must not create its target", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-contain-"));
    const outside = join(mkdtempSync(join(tmpdir(), "agboss-outside-")), "not-yet");
    symlinkSync(outside, join(root, ".claude"), "dir");

    const done = syncSkills({ root, isEnabled: true }, "check", { home: () => undefined });

    expect(done.warnings.map((warning) => warning.code)).toEqual([
      SkillsWarningCode.OutsideProject,
    ]);
    expect(existsSync(outside)).toBe(false);
    expect(linkClaudeSkills(root).status).toBe(LinkStatus.Blocked);
    expect(existsSync(outside)).toBe(false);
  });

  it("a symlinked parent that stays inside the project is fine", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-contain-"));
    mkdirSync(join(root, "vendor/agents"), { recursive: true });
    symlinkSync(join(root, "vendor/agents"), join(root, ".agents"), "dir");

    const done = syncSkills({ root, isEnabled: true }, "check", { home: () => undefined });

    expect(done.result.status).toBe(SkillsSyncStatus.Installed);
    expect(done.warnings).toEqual([]);
    expect(readFileSync(join(root, "vendor/agents/skills/agboss/SKILL.md"), "utf8")).toContain(
      "name: agboss",
    );
  });
});
