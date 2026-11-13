/**
 * #983 AC1 / AC6: `.claude/skills/agboss` is a link to the one copy — a relative symlink on POSIX, a
 * junction on Windows — never a second copy; what is the project's stays untouched with a warning;
 * a link that cannot be made is `[skills.link-failed]` with the command to run.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkClaudeSkills, REAL_LINK_OPS, type LinkOps } from "../../src/skills/link.js";
import { MANIFEST_FILE } from "../../src/skills/manifest.js";
import { LinkStatus, SkillsWarningCode } from "../../src/skills/status.js";

const root = (name = "agboss-link-"): string => mkdtempSync(join(tmpdir(), name));
const copyOf = (at: string): string => join(at, ".agents/skills/agboss");
const linkOf = (at: string): string => join(at, ".claude/skills/agboss");

/** A project whose copy exists (the link points at something real). */
function project(name?: string): string {
  const at = root(name);
  mkdirSync(copyOf(at), { recursive: true });
  writeFileSync(join(copyOf(at), "SKILL.md"), "skill");
  return at;
}

describe("#983 AC1: the link", () => {
  it("AC1: absent → a relative symlink to the copy; no skill file exists twice (one realpath)", () => {
    const at = project();

    const done = linkClaudeSkills(at);

    expect(done).toEqual({ status: LinkStatus.Linked, warnings: [] });
    expect(lstatSync(linkOf(at)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkOf(at))).toBe("../../.agents/skills/agboss");
    expect(realpathSync(join(linkOf(at), "SKILL.md"))).toBe(
      realpathSync(join(copyOf(at), "SKILL.md")),
    );
  });

  it("AC1: a link that already resolves to the copy is current: nothing is done", () => {
    const at = project();
    linkClaudeSkills(at);
    const calls: string[] = [];
    const ops: LinkOps = {
      ...REAL_LINK_OPS,
      symlink: (target, path) => calls.push(`${target} ${path}`),
      unlink: (path) => calls.push(`unlink ${path}`),
    };

    expect(linkClaudeSkills(at, ops)).toEqual({ status: LinkStatus.Current, warnings: [] });
    expect(calls).toEqual([]);
  });

  it("AC1: a root path with spaces and a symlinked .claude/skills still link to the copy", () => {
    const at = project("agboss link spaces-");
    const elsewhere = root();
    mkdirSync(join(at, ".claude"), { recursive: true });
    symlinkSync(elsewhere, join(at, ".claude/skills"), "dir");

    expect(linkClaudeSkills(at).status).toBe(LinkStatus.Linked);
    expect(readFileSync(join(linkOf(at), "SKILL.md"), "utf8")).toBe("skill");
  });

  it("AC1: Windows makes a junction to the absolute path of the copy", () => {
    const at = project();
    const made: { target: string; type: string }[] = [];
    const ops: LinkOps = {
      ...REAL_LINK_OPS,
      platform: "win32",
      symlink: (target, path, type) => {
        made.push({ target, type });
        symlinkSync(target, path, "dir");
      },
    };

    expect(linkClaudeSkills(at, ops).status).toBe(LinkStatus.Linked);
    expect(made).toEqual([{ target: copyOf(at), type: "junction" }]);
  });

  it("AC1: Windows compares real paths — a \\\\?\\ prefix and another case are the same copy", () => {
    const at = "C:\\Users\\me\\demo";
    const ops: LinkOps = {
      platform: "win32",
      lstat: () => ({ isSymbolicLink: () => true, isDirectory: () => false }),
      realpath: (path) =>
        path.toLowerCase().includes(".claude")
          ? "\\\\?\\C:\\Users\\me\\demo\\.agents\\skills\\agboss"
          : "c:\\users\\me\\demo\\.agents\\skills\\agboss",
      symlink: () => {
        throw new Error("no link must be made");
      },
      unlink: () => {
        throw new Error("nothing to remove");
      },
      mkdir: () => undefined,
    };

    expect(linkClaudeSkills(at, ops).status).toBe(LinkStatus.Current);
  });
});

describe("#983 AC6: what is in the way, and a link that cannot be made", () => {
  it("AC6: a user folder blocks the link: byte-identical, [skills.link-blocked]", () => {
    const at = project();
    mkdirSync(linkOf(at), { recursive: true });
    writeFileSync(join(linkOf(at), "SKILL.md"), "mine");

    const done = linkClaudeSkills(at);

    expect(done.status).toBe(LinkStatus.Blocked);
    expect(done.warnings).toEqual([
      {
        code: SkillsWarningCode.LinkBlocked,
        message:
          ".claude/skills/agboss/ is not managed by agboss — Claude Code and Cline will not see the agboss skill; move your files out and run npx agboss check",
      },
    ]);
    expect(readFileSync(join(linkOf(at), "SKILL.md"), "utf8")).toBe("mine");
    expect(lstatSync(linkOf(at)).isSymbolicLink()).toBe(false);
  });

  it("AC6: a foreign symlink is kept; a dangling one is replaced; one to an agboss folder is replaced", () => {
    const foreign = project();
    const user = root();
    mkdirSync(join(foreign, ".claude/skills"), { recursive: true });
    symlinkSync(user, linkOf(foreign), "dir");
    const dangling = project();
    mkdirSync(join(dangling, ".claude/skills"), { recursive: true });
    symlinkSync(join(dangling, "nowhere"), linkOf(dangling), "dir");
    const managed = project();
    const old = root();
    writeFileSync(join(old, MANIFEST_FILE), '{ "version": "0.0.1", "files": {} }');
    mkdirSync(join(managed, ".claude/skills"), { recursive: true });
    symlinkSync(old, linkOf(managed), "dir");

    const kept = linkClaudeSkills(foreign);

    expect(kept.status).toBe(LinkStatus.Blocked);
    expect(kept.warnings[0]?.code).toBe(SkillsWarningCode.LinkBlocked);
    expect(realpathSync(linkOf(foreign))).toBe(realpathSync(user));
    for (const at of [dangling, managed]) {
      expect(linkClaudeSkills(at).status).toBe(LinkStatus.Linked);
      expect(realpathSync(linkOf(at))).toBe(realpathSync(copyOf(at)));
    }
  });

  it("AC6: symlink throws → [skills.link-failed] with the reason and the ln command, no copy made", () => {
    const at = project();
    const ops: LinkOps = {
      ...REAL_LINK_OPS,
      symlink: () => {
        throw new Error("EACCES: permission denied");
      },
    };

    const done = linkClaudeSkills(at, ops);

    expect(done.status).toBe(LinkStatus.Failed);
    expect(done.warnings).toEqual([
      {
        code: SkillsWarningCode.LinkFailed,
        message:
          ".claude/skills/agboss not linked: EACCES: permission denied — Claude Code and Cline will not see the agboss skill until you run: mkdir -p .claude/skills && ln -s ../../.agents/skills/agboss .claude/skills/agboss",
      },
    ]);
    expect(() => lstatSync(linkOf(at))).toThrow();
  });

  it("AC6: on Windows the command is mklink /J", () => {
    const at = project();
    const ops: LinkOps = {
      ...REAL_LINK_OPS,
      platform: "win32",
      symlink: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };

    expect(linkClaudeSkills(at, ops).warnings[0]?.message).toContain(
      "run: mklink /J .claude\\skills\\agboss .agents\\skills\\agboss",
    );
  });

  it("AC6: a read-only or missing parent (a file where .claude goes) is [skills.link-failed], never a throw", () => {
    const at = project();
    writeFileSync(join(at, ".claude"), "a file");

    const done = linkClaudeSkills(at);

    expect(done.status).toBe(LinkStatus.Failed);
    expect(done.warnings[0]?.code).toBe(SkillsWarningCode.LinkFailed);
  });

  it("AC6: a link that cannot be removed for replacing is [skills.link-failed] too", () => {
    const at = project();
    mkdirSync(join(at, ".claude/skills"), { recursive: true });
    symlinkSync(join(at, "nowhere"), linkOf(at), "dir");
    const ops: LinkOps = {
      ...REAL_LINK_OPS,
      unlink: () => {
        throw new Error("EBUSY: resource busy");
      },
    };

    const done = linkClaudeSkills(at, ops);

    expect(done.status).toBe(LinkStatus.Failed);
    expect(done.warnings[0]?.message).toContain("EBUSY");
  });
});
