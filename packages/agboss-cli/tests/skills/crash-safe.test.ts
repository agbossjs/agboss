/**
 * #983 acceptance fix-forward, D1 and D2: a crash between the swap's two renames loses nothing (the
 * project's own skill files come back), and no write goes through a link inside the managed folder.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../src/skills/replace.js";
import { cliSkillsSource } from "../../src/skills/source.js";
import { SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";

const noHome = { home: () => undefined };
const sync = (root: string, replace?: ReplaceOps) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, ...(replace ? { replace } : {}) });
const copyOf = (root: string): string => join(root, ".agents/skills/agboss");
const scratchOf = (root: string): string[] =>
  readdirSync(join(root, ".agents")).filter((name) => name.startsWith(".agboss-skills-"));
const child = new URL("../fixtures/cli/skills-sync-child.ts", import.meta.url).pathname;

/** A synced project whose copy says it was written by 0.1.0, with a file of the project's own. */
function projectWithOwnFile(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-crash-"));
  sync(root);
  const manifest = readManifest(copyOf(root));
  writeFileSync(
    join(copyOf(root), MANIFEST_FILE),
    JSON.stringify({ version: "0.1.0", files: manifest?.files ?? {} }),
  );
  mkdirSync(join(copyOf(root), "team"));
  writeFileSync(join(copyOf(root), "team/mine.md"), "the team's rules");
  return root;
}

/** Ages every temporary folder past the leftover bound, as if the crash were an hour old. */
function ageScratch(root: string): void {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const name of scratchOf(root)) utimesSync(join(root, ".agents", name), old, old);
}

describe("#983 D1: a crash between the swap's two renames", () => {
  it("#983 D1: both renames fail (injected): the next run restores the folder, the own file survives", () => {
    const root = projectWithOwnFile();
    let renames = 0;
    const crashing: ReplaceOps = {
      ...REAL_REPLACE_OPS,
      rename: (from, to) => {
        renames += 1;
        if (renames > 1) throw new Error("killed");
        renameSync(from, to);
      },
    };
    expect(sync(root, crashing).result.status).toBe(SkillsSyncStatus.Failed);
    expect(existsSync(copyOf(root))).toBe(false);

    const done = sync(root);

    expect(readFileSync(join(copyOf(root), "team/mine.md"), "utf8")).toBe("the team's rules");
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
    expect(readManifest(copyOf(root))?.version).toBe(cliSkillsSource()?.version);
  });

  it("#983 D1: a real SIGKILL between the renames: the project file survives the next run", () => {
    const root = projectWithOwnFile();

    const killed = spawnSync(process.execPath, ["--import", "tsx", child, root, "kill"], {
      encoding: "utf8",
    });
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(copyOf(root))).toBe(false);
    ageScratch(root);

    const done = sync(root);

    expect(readFileSync(join(copyOf(root), "team/mine.md"), "utf8")).toBe("the team's rules");
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
  });

  it("#983 D1: a leftover whose own file is not in the live folder is kept and named; one whose files are all there is removed", () => {
    const root = projectWithOwnFile();
    sync(root);
    const keep = join(root, ".agents/.agboss-skills-aaaa-old");
    cpSync(copyOf(root), keep, { recursive: true });
    writeFileSync(join(keep, "lost.md"), "only here");
    const drop = join(root, ".agents/.agboss-skills-bbbb-old");
    cpSync(copyOf(root), drop, { recursive: true });
    ageScratch(root);

    const done = sync(root);

    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
    expect(done.warnings).toEqual([
      expect.objectContaining({
        code: SkillsWarningCode.UnmanagedFile,
        message: expect.stringContaining(".agents/.agboss-skills-aaaa-old"),
      }),
    ]);
  });

  it("#983 D1: with two valid leftovers and no folder, the newest is restored", () => {
    const root = projectWithOwnFile();
    const older = join(root, ".agents/.agboss-skills-1111-old");
    const newer = join(root, ".agents/.agboss-skills-2222");
    cpSync(copyOf(root), older, { recursive: true });
    cpSync(copyOf(root), newer, { recursive: true });
    writeFileSync(join(newer, "team/mine.md"), "newer rules");
    utimesSync(older, new Date(1000), new Date(1000));
    renameSync(copyOf(root), join(root, "gone"));

    sync(root);

    expect(readFileSync(join(copyOf(root), "team/mine.md"), "utf8")).toBe("newer rules");
  });
});

describe("#983 D2: no write through a link inside the managed folder", () => {
  /** The crafted layout: a managed 0.1.x folder with `extra/planted.md`; the copy's `extra` is a link outside. */
  function craftedMigration(): { root: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), "agboss-link-"));
    const outside = mkdtempSync(join(tmpdir(), "agboss-outside-"));
    sync(root);
    unlinkSync(join(root, ".claude/skills/agboss"));
    cpSync(copyOf(root), join(root, ".claude/skills/agboss"), { recursive: true });
    mkdirSync(join(root, ".claude/skills/agboss/extra"));
    writeFileSync(join(root, ".claude/skills/agboss/extra/planted.md"), "planted");
    symlinkSync(outside, join(copyOf(root), "extra"), "dir");
    return { root, outside };
  }

  it("#983 D2: a symlinked subfolder in the copy: [skills.outside-project], nothing written outside", () => {
    const { root, outside } = craftedMigration();

    const done = sync(root);

    expect(done.warnings.map((warning) => warning.code)).toContain(
      SkillsWarningCode.OutsideProject,
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, ".claude/skills/agboss/extra/planted.md"))).toBe(true);
  });

  it("#983 D2: a symlinked file in the copy pointing outside is replaced, never written through", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-link-"));
    sync(root);
    const outside = join(mkdtempSync(join(tmpdir(), "agboss-outside-")), "SKILL.md");
    writeFileSync(outside, "outside file");
    unlinkSync(join(copyOf(root), "SKILL.md"));
    symlinkSync(outside, join(copyOf(root), "SKILL.md"));

    sync(root);

    expect(readFileSync(outside, "utf8")).toBe("outside file");
    expect(lstatSync(join(copyOf(root), "SKILL.md")).isSymbolicLink()).toBe(false);
  });
});
