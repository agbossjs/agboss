/**
 * #983 AC5: a personal `~/.claude/skills/agboss` of another version wins over the project's in
 * Claude Code: `agboss check` warns, with the remedy. The home folder is `os.homedir()`; none, or
 * one that cannot be read, is no warning and no error.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shadowWarning } from "../../src/skills/shadow.js";
import { SkillsWarningCode } from "../../src/skills/status.js";
import { syncSkills } from "../../src/skills/sync.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A home folder with a personal skill whose SKILL.md is `text`. */
function homeWith(text: string): string {
  const home = mkdtempSync(join(tmpdir(), "agboss-home-"));
  mkdirSync(join(home, ".claude/skills/agboss"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/agboss/SKILL.md"), text);
  return home;
}

const headerOf = (version: string): string =>
  `---\nname: agboss\n---\n\n<!-- agboss-skills-version: ${version} — managed by \`agboss check\`; edits here are replaced -->\n`;

describe("#983 AC5: the shadow check", () => {
  it("AC5: stale ~/.claude/skills/agboss warns, with its version, the project's, and the remedy", () => {
    const home = homeWith(headerOf("0.0.9"));

    expect(shadowWarning("0.1.2", () => home)).toEqual({
      code: SkillsWarningCode.Shadowed,
      message:
        "~/.claude/skills/agboss is agboss 0.0.9 — Claude Code uses a personal skill over the project's (0.1.2); remove it: rm -rf ~/.claude/skills/agboss",
    });
  });

  it("AC5: the same version gives no warning; the version is also read from metadata.agboss-version", () => {
    expect(shadowWarning("0.1.2", () => homeWith(headerOf("0.1.2")))).toBeUndefined();
    const framed = '---\nname: agboss\nmetadata:\n  agboss-version: "0.1.2"\n---\n';
    expect(shadowWarning("0.1.2", () => homeWith(framed))).toBeUndefined();
    expect(shadowWarning("0.1.3", () => homeWith(framed))?.message).toContain("agboss 0.1.2 —");
  });

  it("AC5: no personal skill, no home, an unreadable SKILL.md or a throwing home: silent", () => {
    const empty = mkdtempSync(join(tmpdir(), "agboss-home-"));
    const unreadable = mkdtempSync(join(tmpdir(), "agboss-home-"));
    mkdirSync(join(unreadable, ".claude/skills/agboss/SKILL.md"), { recursive: true });

    expect(shadowWarning("0.1.2", () => empty)).toBeUndefined();
    expect(shadowWarning("0.1.2", () => undefined)).toBeUndefined();
    expect(shadowWarning("0.1.2", () => unreadable)).toBeUndefined();
    expect(
      shadowWarning("0.1.2", () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });

  it("AC5: the default home is os.homedir(), which honours HOME (USERPROFILE on Windows)", () => {
    vi.stubEnv("HOME", homeWith(headerOf("0.0.9")));
    vi.stubEnv("USERPROFILE", homeWith(headerOf("0.0.9")));

    expect(shadowWarning("0.1.2")?.code).toBe(SkillsWarningCode.Shadowed);
  });

  it("AC5: agboss check's sync carries it — and an unset home stays quiet", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-skills-"));
    const home = homeWith(headerOf("0.0.9"));

    const warned = syncSkills({ root, isEnabled: true }, "check", { home: () => home });
    const quiet = syncSkills({ root, isEnabled: true }, "check", { home: () => undefined });

    expect(warned.warnings.map((warning) => warning.code)).toEqual([SkillsWarningCode.Shadowed]);
    expect(quiet.warnings).toEqual([]);
  });
});
