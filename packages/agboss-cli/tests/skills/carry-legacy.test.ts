/**
 * #1013 (b): an interrupted migration where both folders hold the same own file with different
 * bytes loses neither: the `.agents` copy stays, the legacy one is saved as `<name>.legacy`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
