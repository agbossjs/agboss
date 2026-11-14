/**
 * #1013 (a): the project's own links inside `.agents/skills/agboss/` are named when the folder is
 * replaced, kept when they stay inside the project, and never followed.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillsSyncStatus, SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";
import { noHome, oldProject } from "./lock-helpers.js";

describe("#1013 (a): the project's links in the skills folder", () => {
  it("a link inside the project is kept as it is, one that leaves it is dropped, each is named", () => {
    const root = oldProject();
    const copy = join(root, ".agents/skills/agboss");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/rules.md"), "rules");
    symlinkSync("../../../docs/rules.md", join(copy, "rules.md"));
    symlinkSync("../../../docs", join(copy, "shared"), "dir");
    symlinkSync("/etc/hosts", join(copy, "outside.md"));

    const done = syncSkills({ root, isEnabled: true }, "check", noHome);

    expect(done.warnings.filter((w) => w.code === SkillsWarningCode.SyncFailed)).toEqual([]);
    expect(done.result.status).toBe(SkillsSyncStatus.Updated);
    expect(readlinkSync(join(copy, "rules.md"))).toBe("../../../docs/rules.md");
    expect(readlinkSync(join(copy, "shared"))).toBe("../../../docs");
    expect(lstatSync(join(copy, "outside.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readdirSync(join(root, "docs"))).toEqual(["rules.md"]);
    const named = done.warnings.filter((w) => w.code === SkillsWarningCode.UnmanagedFile);
    expect(named.map((w) => w.message).join("\n")).toMatch(/rules\.md[^\n]*kept/);
    expect(named.map((w) => w.message).join("\n")).toMatch(/outside\.md[^\n]*not kept/);
    expect(named).toHaveLength(3);
    expect(syncSkills({ root, isEnabled: true }, "check", noHome).result.status).toBe(
      SkillsSyncStatus.Current,
    );
  });

  it("a link where agboss has a file is replaced by agboss's file, and said", () => {
    const root = oldProject();
    const copy = join(root, ".agents/skills/agboss");
    writeFileSync(join(root, "mine.md"), "mine");
    unlinkSync(join(copy, "references/02-flow-dsl-all-combinations.md"));
    symlinkSync("../../../../mine.md", join(copy, "references/02-flow-dsl-all-combinations.md"));

    const done = syncSkills({ root, isEnabled: true }, "check", noHome);

    expect(lstatSync(join(copy, "references/02-flow-dsl-all-combinations.md")).isFile()).toBe(true);
    expect(done.warnings.map((w) => w.message).join("\n")).toContain("replaced by agboss's");
  });

  it("#1076: an absolute link spelled through an alias of the project's path is kept; one that really leaves is not", () => {
    const root = oldProject();
    const copy = join(root, ".agents/skills/agboss");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/rules.md"), "rules");
    const alias = join(mkdtempSync(join(tmpdir(), "agboss-alias-")), "project");
    symlinkSync(realpathSync(root), alias, "dir");
    symlinkSync(join(alias, "docs/rules.md"), join(copy, "via-alias.md"));
    symlinkSync(join(alias, "docs/missing.md"), join(copy, "dangling.md"));
    symlinkSync(join(alias, "..", "elsewhere.md"), join(copy, "leaves.md"));

    syncSkills({ root, isEnabled: true }, "check", noHome);

    expect(readlinkSync(join(copy, "via-alias.md"))).toBe(join(alias, "docs/rules.md"));
    expect(readlinkSync(join(copy, "dangling.md"))).toBe(join(alias, "docs/missing.md"));
    expect(lstatSync(join(copy, "leaves.md"), { throwIfNoEntry: false })).toBeUndefined();
  });
});
