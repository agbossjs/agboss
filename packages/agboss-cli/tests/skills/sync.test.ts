/**
 * #305 AC4: `agboss check` / `generate` sync `.claude/skills/agboss/` with the skills of the
 * `agboss` the project resolves — installed when missing, replaced on another version, repaired at
 * the same one — keeping the project's own files and never touching AGENTS.md; every problem is a
 * warning.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { cliSkillsSource, skillFilesOf } from "../../src/skills/source.js";
import { SKILLS_FOLDER, SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { skillsLines, syncSkills } from "../../src/skills/sync.js";

const REFERENCE = "references/02-flow-dsl-all-combinations.md";
const source = cliSkillsSource();
const version = source?.version ?? "";
const fileCount = source === undefined ? 0 : skillFilesOf(source).length;

const projectRoot = (): string => mkdtempSync(join(tmpdir(), "agboss-skills-"));
const sync = (root: string) => syncSkills({ root, isEnabled: true }, "check");
const folderOf = (root: string): string => join(root, SKILLS_FOLDER);
const read = (root: string, path: string): string =>
  readFileSync(join(folderOf(root), path), "utf8");

/** Sets the folder's manifest (and SKILL.md's header) to another version, as an old agboss wrote it. */
function downgrade(root: string, to: string): void {
  const manifest = readManifest(folderOf(root));
  writeFileSync(
    join(folderOf(root), MANIFEST_FILE),
    JSON.stringify({ version: to, files: manifest?.files ?? {} }),
  );
}

describe("#305 AC4: the skills sync", () => {
  it("installs the skills of the CLI's own agboss when the folder is missing: 14 files and the manifest", () => {
    const root = projectRoot();

    const done = sync(root);

    expect(done.result).toMatchObject({ status: SkillsSyncStatus.Installed, version });
    expect(done.result.written).toHaveLength(14);
    expect(fileCount).toBe(14);
    expect(read(root, "SKILL.md")).toMatch(
      new RegExp(`^---\\nname: agboss\\n[^]*?---\\n\\n<!-- agboss-skills-version: ${version} — `),
    );
    expect(readManifest(folderOf(root))?.version).toBe(version);
    expect(skillsLines(done)).toEqual([
      `skills: .claude/skills/agboss installed for agboss ${version} (14 files)`,
    ]);
  });

  it("current skills: nothing written, nothing printed", () => {
    const root = projectRoot();
    sync(root);

    const done = sync(root);

    expect(done.result.status).toBe(SkillsSyncStatus.Current);
    expect(skillsLines(done)).toEqual([]);
  });

  it("another version in the manifest: every file replaced, from → to printed", () => {
    const root = projectRoot();
    sync(root);
    downgrade(root, "0.0.1");

    const done = sync(root);

    expect(done.result).toMatchObject({ status: SkillsSyncStatus.Updated, previous: "0.0.1" });
    expect(skillsLines(done)).toEqual([
      `skills: .claude/skills/agboss updated 0.0.1 → ${version} (14 files)`,
    ]);
    expect(readManifest(folderOf(root))?.version).toBe(version);
  });

  it("a file edited by hand: restored, with [skills.local-edit]; a deleted one restored quietly", () => {
    const root = projectRoot();
    sync(root);
    const original = read(root, REFERENCE);
    appendFileSync(join(folderOf(root), REFERENCE), "\nmy own rule\n");

    const done = sync(root);

    expect(skillsLines(done)).toEqual([
      `warning: [skills.local-edit] .claude/skills/agboss/${REFERENCE} was edited — replaced by agboss ${version}'s; put project rules in AGENTS.md`,
      "skills: .claude/skills/agboss repaired (1 file)",
    ]);
    expect(read(root, REFERENCE)).toBe(original);
  });

  it("a file of the old manifest the new version lacks is removed; the project's own files are kept", () => {
    const root = projectRoot();
    sync(root);
    writeFileSync(join(folderOf(root), "references/99-gone.md"), "old");
    writeFileSync(join(folderOf(root), "notes.md"), "mine");
    const manifest = readManifest(folderOf(root));
    writeFileSync(
      join(folderOf(root), MANIFEST_FILE),
      JSON.stringify({
        version: "0.0.1",
        files: { ...manifest?.files, "references/99-gone.md": "sha256-x" },
      }),
    );

    const done = sync(root);

    expect(done.result.removed).toEqual(["references/99-gone.md"]);
    expect(existsSync(join(folderOf(root), "references/99-gone.md"))).toBe(false);
    expect(read(root, "notes.md")).toBe("mine");
    expect(done.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([SkillsWarningCode.UnmanagedFile, SkillsWarningCode.LocalEdit]),
    );
  });

  it("AGENTS.md and CLAUDE.md are never read or changed", () => {
    const root = projectRoot();
    writeFileSync(join(root, "AGENTS.md"), "# rules\n\nmine\n");
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    sync(root);
    downgrade(root, "0.0.1");

    sync(root);

    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# rules\n\nmine\n");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("turned off: nothing read or written, nothing printed", () => {
    const root = projectRoot();

    const done = syncSkills({ root, isEnabled: false }, "check");

    expect(done.result.status).toBe(SkillsSyncStatus.Off);
    expect(skillsLines(done)).toEqual([]);
    expect(existsSync(folderOf(root))).toBe(false);
  });

  it("an unwritable folder: [skills.sync-failed], the command goes on", () => {
    const root = projectRoot();
    writeFileSync(join(root, ".claude"), "a file where the folder goes");

    const done = sync(root);

    expect(done.result.status).toBe(SkillsSyncStatus.Failed);
    expect(skillsLines(done)).toEqual([
      expect.stringMatching(
        /^warning: \[skills\.sync-failed\] \.claude\/skills\/agboss not written: .+ — the check went on$/,
      ),
    ]);
  });

  it("the project's own agboss wins over the CLI's; one that ships no skills is [skills.no-framework]", () => {
    const withSkills = projectRoot();
    const own = join(withSkills, "node_modules/agboss");
    mkdirSync(join(own, "skills/agboss"), { recursive: true });
    writeFileSync(join(own, "package.json"), '{ "name": "agboss", "version": "9.9.9" }');
    writeFileSync(join(own, "skills/agboss/SKILL.md"), "---\nname: agboss\n---\n");
    const older = projectRoot();
    mkdirSync(join(older, "node_modules/agboss"), { recursive: true });
    writeFileSync(join(older, "node_modules/agboss/package.json"), '{ "version": "0.0.9" }');

    expect(sync(withSkills).result).toMatchObject({ version: "9.9.9", written: ["SKILL.md"] });
    expect(skillsLines(sync(older))).toEqual([
      "warning: [skills.no-framework] agboss 0.0.9 ships no skills — skills not synced (upgrade agboss)",
    ]);
  });
});
