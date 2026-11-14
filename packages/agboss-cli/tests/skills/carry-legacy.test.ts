/**
 * #1013 (b): an interrupted migration where both folders hold the same own file with different
 * bytes loses neither: the `.agents` copy stays, the legacy one is saved as `<name>.legacy`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest } from "../../src/skills/manifest.js";
import { REAL_REPLACE_OPS, type ReplaceOps } from "../../src/skills/replace.js";
import { SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import { noHome } from "./lock-helpers.js";

const sync = (root: string, replace?: ReplaceOps) =>
  syncSkills({ root, isEnabled: true }, "check", { ...noHome, ...(replace ? { replace } : {}) });

/** A 0.1.0 project whose move crashed before the old folder's removal; own `team/notes.md` in both. */
function interruptedMove(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-legacy-"));
  const copy = join(root, ".agents/skills/agboss");
  const legacy = join(root, ".claude/skills/agboss");
  sync(root);
  unlinkSync(legacy);
  renameSync(copy, legacy);
  const files = readManifest(legacy)?.files ?? {};
  writeFileSync(join(legacy, MANIFEST_FILE), JSON.stringify({ version: "0.1.0", files }));
  mkdirSync(join(legacy, "team"));
  writeFileSync(join(legacy, "team/notes.md"), "old notes");
  const crash: ReplaceOps = {
    ...REAL_REPLACE_OPS,
    rm: (path) => {
      if (path === legacy) throw new Error("EBUSY: crash before the removal");
      REAL_REPLACE_OPS.rm(path);
    },
  };
  sync(root, crash);
  writeFileSync(join(copy, "team/notes.md"), "edited after the crash");
  return root;
}

describe("#1013 (b): both folders hold the same own file", () => {
  it("the .agents copy stays, the legacy bytes are saved as .legacy, one warning names it", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");

    const done = sync(root);

    expect(readFileSync(join(copy, "team/notes.md"), "utf8")).toBe("edited after the crash");
    expect(readFileSync(join(copy, "team/notes.md.legacy"), "utf8")).toBe("old notes");
    const named = done.warnings.filter((w) => w.message.includes("notes.md.legacy"));
    expect(named).toHaveLength(1);
    expect(named[0]?.code).toBe(SkillsWarningCode.UnmanagedFile);
  });

  it("identical bytes make no .legacy file", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");
    writeFileSync(join(copy, "team/notes.md"), "old notes");

    sync(root);

    expect(existsSync(join(copy, "team/notes.md.legacy"))).toBe(false);
  });
});

describe("#1013 (b) #1077: no entry of the old folder is lost silently", () => {
  it("a link where the old folder has a file: the file is saved as .legacy and named", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/rules.md"), "rules");
    unlinkSync(join(copy, "team/notes.md"));
    symlinkSync("../../../../docs/rules.md", join(copy, "team/notes.md"));

    const done = sync(root);

    expect(readlinkSync(join(copy, "team/notes.md"))).toBe("../../../../docs/rules.md");
    expect(readFileSync(join(copy, "team/notes.md.legacy"), "utf8")).toBe("old notes");
    expect(done.warnings.some((w) => w.message.includes("notes.md.legacy"))).toBe(true);
    expect(lstatSync(join(root, ".claude/skills/agboss")).isSymbolicLink()).toBe(true);
  });

  it("a folder where the old folder has a file: the file is saved as .legacy and named", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");
    unlinkSync(join(copy, "team/notes.md"));
    mkdirSync(join(copy, "team/notes.md"));

    const done = sync(root);

    expect(readFileSync(join(copy, "team/notes.md.legacy"), "utf8")).toBe("old notes");
    expect(done.warnings.some((w) => w.message.includes("notes.md.legacy"))).toBe(true);
  });

  it("an existing .legacy of other content is never overwritten: the next name is used", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");
    writeFileSync(join(copy, "team/notes.md.legacy"), "someone else's");

    sync(root);

    expect(readFileSync(join(copy, "team/notes.md.legacy"), "utf8")).toBe("someone else's");
    expect(readFileSync(join(copy, "team/notes.md.legacy.2"), "utf8")).toBe("old notes");
  });

  it("an own link inside the old folder is carried when it stays inside the project, named; one that leaves is dropped, named", () => {
    const root = interruptedMove();
    const copy = join(root, ".agents/skills/agboss");
    const legacy = join(root, ".claude/skills/agboss");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/rules.md"), "rules");
    symlinkSync("../../../docs/rules.md", join(legacy, "rules.md"));
    symlinkSync("/etc/hosts", join(legacy, "outside.md"));

    const done = sync(root);

    expect(readlinkSync(join(copy, "rules.md"))).toBe("../../../docs/rules.md");
    expect(lstatSync(join(copy, "outside.md"), { throwIfNoEntry: false })).toBeUndefined();
    const text = done.warnings.map((w) => w.message).join("\n");
    expect(text).toMatch(/rules\.md[^\n]*kept/);
    expect(text).toMatch(/outside\.md[^\n]*not kept/);
  });
});

describe("#1013 security: a carried link is judged where it is written; no move through a linked parent", () => {
  it("a relative link inside the project from the old folder but outside from the new place is not created, and named", () => {
    const root = interruptedMove();
    const legacy = join(root, ".claude/skills/agboss");
    writeFileSync(join(root, "x"), "x");
    symlinkSync("../../../x", join(legacy, "l.md"));
    // `.agents/skills` is a link to a folder one level up from where `.agents/skills/agboss` would be
    renameSync(join(root, ".agents/skills"), join(root, "a"));
    symlinkSync("../a", join(root, ".agents/skills"), "dir");

    const done = sync(root);

    expect(lstatSync(join(root, "a/agboss/l.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(
      done.warnings.some(
        (w) => w.code === SkillsWarningCode.UnmanagedFile && w.message.includes("l.md"),
      ),
    ).toBe(true);
  });

  it("a linked parent of the old folder (inside or outside the project): refused, nothing moved or removed", () => {
    for (const where of ["inside", "outside"]) {
      const root = interruptedMove();
      const moved =
        where === "inside" ? join(root, "vault") : mkdtempSync(join(tmpdir(), "agboss-out-"));
      mkdirSync(moved, { recursive: true });
      renameSync(join(root, ".claude/skills"), join(moved, "skills"));
      symlinkSync(join(moved, "skills"), join(root, ".claude/skills"), "dir");
      const before = readdirSync(join(root, ".agents/skills/agboss/team")).sort();

      const done = sync(root);

      expect(done.warnings.map((w) => w.code)).toContain(SkillsWarningCode.OutsideProject);
      expect(existsSync(join(moved, "skills/agboss/team/notes.md"))).toBe(true);
      expect(readdirSync(join(root, ".agents/skills/agboss/team")).sort()).toEqual(before);
    }
  });
});
