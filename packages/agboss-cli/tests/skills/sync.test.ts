/**
 * #305 AC4: `agboss check` / `generate` sync `.agents/skills/agboss/` (#983) with the skills of the
 * `agboss` the project resolves — installed when missing, replaced on another version, repaired at
 * the same one — keeping the project's own files and never touching AGENTS.md; every problem is a
 * warning.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { cliSkillsSource, skillFilesOf } from "../../src/skills/source.js";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../src/skills/replace.js";
import {
  LinkStatus,
  SKILLS_FOLDER,
  SkillsSyncStatus,
  SkillsWarningCode,
} from "../../src/skills/status.js";
import { skillsLines, syncSkills } from "../../src/skills/sync.js";

const REFERENCE = "references/02-flow-dsl-all-combinations.md";
const source = cliSkillsSource();
const version = source?.version ?? "";
const fileCount = source === undefined ? 0 : skillFilesOf(source).length;

const projectRoot = (): string => mkdtempSync(join(tmpdir(), "agboss-skills-"));
// no personal ~/.claude/skills/agboss of the machine the tests run on
const noHome = { home: () => undefined };
const sync = (root: string, replace?: ReplaceOps) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, ...(replace ? { replace } : {}) });
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
      `skills: .agents/skills/agboss installed for agboss ${version} (14 files) · linked .claude/skills/agboss`,
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
      `skills: .agents/skills/agboss updated 0.0.1 → ${version} (14 files)`,
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
      `warning: [skills.local-edit] .agents/skills/agboss/${REFERENCE} was edited — replaced by agboss ${version}'s; put project rules in AGENTS.md`,
      "skills: .agents/skills/agboss repaired (1 file)",
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
    writeFileSync(join(root, ".agents"), "a file where the folder goes");

    const done = sync(root);

    expect(done.result.status).toBe(SkillsSyncStatus.Failed);
    expect(skillsLines(done)).toEqual([
      expect.stringMatching(
        /^warning: \[skills\.sync-failed\] \.agents\/skills\/agboss not written: .+ — the check went on$/,
      ),
    ]);
  });

  it("the project's own agboss wins over the CLI's; one that ships no skills is [skills.no-framework]", () => {
    const withSkills = projectRoot();
    const own = join(withSkills, "node_modules/@agboss/core");
    mkdirSync(join(own, "skills/agboss"), { recursive: true });
    writeFileSync(join(own, "package.json"), '{ "name": "@agboss/core", "version": "9.9.9" }');
    writeFileSync(join(own, "skills/agboss/SKILL.md"), "---\nname: agboss\n---\n");
    const older = projectRoot();
    mkdirSync(join(older, "node_modules/@agboss/core"), { recursive: true });
    writeFileSync(join(older, "node_modules/@agboss/core/package.json"), '{ "version": "0.0.9" }');

    expect(sync(withSkills).result).toMatchObject({ version: "9.9.9", written: ["SKILL.md"] });
    expect(skillsLines(sync(older))).toEqual([
      "warning: [skills.no-framework] agboss 0.0.9 ships no skills — skills not synced (upgrade agboss)",
    ]);
  });
});

const linkOf = (root: string): string => join(root, ".claude/skills/agboss");
const crlfOf = (root: string, path: string): void => {
  const file = join(folderOf(root), path);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
};

describe("#983: one committed copy and a local link", () => {
  it("AC3: update replaces the one copy, link still resolves; the swap leaves no .agboss-skills-* under .agents/skills/", () => {
    const root = projectRoot();
    sync(root);
    downgrade(root, "0.1.0");

    const done = sync(root);

    expect(skillsLines(done)).toEqual([
      `skills: .agents/skills/agboss updated 0.1.0 → ${version} (14 files)`,
    ]);
    expect(done.result.link?.status).toBe(LinkStatus.Current);
    expect(realpathSync(linkOf(root))).toBe(realpathSync(folderOf(root)));
    expect(readFileSync(join(linkOf(root), "SKILL.md"), "utf8")).toBe(read(root, "SKILL.md"));
    expect(readdirSync(join(root, ".agents/skills"))).toEqual(["agboss"]);
    expect(readdirSync(join(root, ".agents"))).toEqual(["skills"]);
  });

  it("AC3: the swap's temporary folder is in .agents/, beside skills/, never inside it", () => {
    const root = projectRoot();
    sync(root);
    downgrade(root, "0.1.0");
    const seen: string[] = [];
    const watching: ReplaceOps = {
      ...REAL_REPLACE_OPS,
      rename: (from, to) => {
        seen.push(from, to);
        REAL_REPLACE_OPS.rename(from, to);
      },
    };

    sync(root, watching);

    const temporary = seen.filter((path) => path.includes(".agboss-skills-"));
    expect(temporary.length).toBeGreaterThan(0);
    for (const path of temporary) {
      expect(path).toContain(join(root, ".agents", ".agboss-skills-"));
      expect(path).not.toContain(join(root, ".agents/skills"));
    }
  });

  it("AC3: a leftover of a crashed swap (.agents/.agboss-skills-*, and 0.1.x's in .claude/skills/) is removed on the next run; a fresh one (another check mid-write) is not", () => {
    const root = projectRoot();
    sync(root);
    const stale = [
      join(root, ".agents/.agboss-skills-ab12cd34-old"),
      join(root, ".agents/.agboss-skills-ffffffff"),
      join(root, ".claude/skills/.agboss-skills-0a0a0a0a"),
    ];
    for (const path of stale) {
      mkdirSync(join(path, "references"), { recursive: true });
      utimesSync(path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    }
    mkdirSync(join(root, ".agents/.agboss-skills-11111111"), { recursive: true });
    mkdirSync(join(root, ".agents/mine"), { recursive: true });

    const done = sync(root);

    expect(readdirSync(join(root, ".agents")).sort()).toEqual([
      ".agboss-skills-11111111",
      "mine",
      "skills",
    ]);
    expect(readdirSync(join(root, ".claude/skills"))).toEqual(["agboss"]);
    expect(done.result.status).toBe(SkillsSyncStatus.Current);
  });

  it('AC4: "skills": false writes, moves and links nothing', () => {
    const root = projectRoot();
    mkdirSync(linkOf(root), { recursive: true });
    writeFileSync(join(linkOf(root), MANIFEST_FILE), '{ "version": "0.1.0", "files": {} }');

    const done = syncSkills({ root, isEnabled: false }, "check", noHome);

    expect(done.result).toEqual({
      status: SkillsSyncStatus.Off,
      folder: ".agents/skills/agboss",
      written: [],
      removed: [],
    });
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(lstatSync(linkOf(root)).isDirectory()).toBe(true);
    expect(readdirSync(linkOf(root))).toEqual([MANIFEST_FILE]);
  });

  it("the link is checked on every run: a current copy with the link removed → only the link is recreated", () => {
    const root = projectRoot();
    sync(root);
    unlinkSync(linkOf(root)); // a fresh clone before postinstall, or a link removed by hand
    const before = read(root, "SKILL.md");

    const done = sync(root);

    expect(done.result).toMatchObject({
      status: SkillsSyncStatus.Current,
      link: { path: ".claude/skills/agboss", status: LinkStatus.Linked },
      written: [],
    });
    expect(skillsLines(done)).toEqual(["skills: linked .claude/skills/agboss"]);
    expect(read(root, "SKILL.md")).toBe(before);
    expect(sync(root).result.link?.status).toBe(LinkStatus.Current);
  });

  it("AC6: the link cannot be made (a file where .claude goes): the copy is written, [skills.link-failed], nothing thrown", () => {
    const root = projectRoot();
    writeFileSync(join(root, ".claude"), "a file");

    const done = sync(root);

    expect(done.result).toMatchObject({
      status: SkillsSyncStatus.Installed,
      link: { status: LinkStatus.Failed },
    });
    expect(done.warnings.map((warning) => warning.code)).toEqual([SkillsWarningCode.LinkFailed]);
    expect(existsSync(join(folderOf(root), "SKILL.md"))).toBe(true);
  });

  it("AC6: a failed copy attempts no link (it would dangle)", () => {
    const root = projectRoot();
    writeFileSync(join(root, ".agents"), "a file");

    const done = sync(root);

    expect(done.result.link).toBeUndefined();
    expect(existsSync(linkOf(root))).toBe(false);
  });

  it("CRLF: a managed file checked out with CRLF (Windows core.autocrlf) is current, no warning, no rewrite", () => {
    const root = projectRoot();
    sync(root);
    crlfOf(root, REFERENCE);
    crlfOf(root, "SKILL.md");
    const onDisk = read(root, REFERENCE);

    const done = sync(root);

    expect(onDisk).toContain("\r\n");
    expect(done.result.status).toBe(SkillsSyncStatus.Current);
    expect(done.warnings).toEqual([]);
    expect(read(root, REFERENCE)).toBe(onDisk);
  });

  it("CRLF: a real edit in a CRLF file is still a local edit", () => {
    const root = projectRoot();
    sync(root);
    crlfOf(root, REFERENCE);
    appendFileSync(join(folderOf(root), REFERENCE), "my own rule\r\n");

    const done = sync(root);

    expect(done.warnings.map((warning) => warning.code)).toEqual([SkillsWarningCode.LocalEdit]);
  });
});

/** A rename that fails `times` times with `code`, then works. */
function flaky(
  code: string,
  times: number,
): { ops: ReplaceOps; waits: number[]; calls: () => number } {
  const waits: number[] = [];
  let calls = 0;
  const ops: ReplaceOps = {
    ...REAL_REPLACE_OPS,
    rename: (from, to) => {
      calls += 1;
      if (calls <= times) throw Object.assign(new Error(`${code}: held`), { code });
      REAL_REPLACE_OPS.rename(from, to);
    },
    wait: (ms) => waits.push(ms),
  };
  return { ops, waits, calls: () => calls };
}

describe("#983: the swap on Windows (a rename an antivirus or indexer holds)", () => {
  it("EBUSY / EPERM are retried a bounded number of times, with growing waits", () => {
    for (const code of ["EBUSY", "EPERM"]) {
      const root = projectRoot();
      sync(root);
      downgrade(root, "0.1.0");
      const held = flaky(code, 2);

      const done = sync(root, held.ops);

      expect(done.result.status).toBe(SkillsSyncStatus.Updated);
      expect(held.waits).toEqual([50, 100]);
      expect(readManifest(folderOf(root))?.version).toBe(version);
    }
  });

  it("a folder held for good: after 5 attempts the sync warns [skills.sync-failed] and the old folder is intact", () => {
    const root = projectRoot();
    sync(root);
    downgrade(root, "0.1.0");
    const held = flaky("EBUSY", 1000);

    const done = sync(root, held.ops);

    expect(done.result.status).toBe(SkillsSyncStatus.Failed);
    expect(done.warnings[0]?.code).toBe(SkillsWarningCode.SyncFailed);
    expect(held.calls()).toBe(5);
    expect(held.waits).toEqual([50, 100, 200, 400]);
    expect(readManifest(folderOf(root))?.version).toBe("0.1.0");
    expect(existsSync(join(folderOf(root), "SKILL.md"))).toBe(true);
    expect(readdirSync(join(root, ".agents"))).toEqual(["skills"]);
  });

  it("any other rename error is not retried, and the old folder comes back (atomic: old or new, never half)", () => {
    const root = projectRoot();
    sync(root);
    downgrade(root, "0.1.0");
    let calls = 0;
    const ops: ReplaceOps = {
      ...REAL_REPLACE_OPS,
      rename: (from, to) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("EXDEV: no"), { code: "EXDEV" });
        REAL_REPLACE_OPS.rename(from, to);
      },
      wait: () => {
        throw new Error("no wait for EXDEV");
      },
    };

    const done = sync(root, ops);

    expect(done.result.status).toBe(SkillsSyncStatus.Failed);
    expect(readManifest(folderOf(root))?.version).toBe("0.1.0");
    expect(existsSync(join(folderOf(root), "SKILL.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
