import { lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readManifest } from "./manifest.js";
import {
  CLAUDE_SKILLS_LINK,
  LinkStatus,
  SKILLS_FOLDER,
  SkillsWarningCode,
  type SkillsWarning,
} from "./status.js";

/**
 * The link `.claude/skills/agboss` → `.agents/skills/agboss` (#983): Claude Code and Cline read
 * only `.claude/skills/`, every other agent reads the committed folder. A POSIX relative symlink,
 * on Windows a junction (the one link type that needs no rights). Never a second copy: a link that
 * cannot be made is a warning with the command to run. Checked on every sync, the copy current or
 * not. The file-system calls are a parameter so the Windows paths run on any platform in tests.
 */

/** The file-system calls the link needs. */
export interface LinkOps {
  readonly platform: NodeJS.Platform;
  /** The entry itself (a link is not followed); undefined when there is none. */
  readonly lstat: (path: string) => Pick<Stats, "isSymbolicLink" | "isDirectory"> | undefined;
  /** Where a path resolves to; undefined when it does not (a dangling link). */
  readonly realpath: (path: string) => string | undefined;
  readonly symlink: (target: string, path: string, type: "dir" | "junction") => void;
  readonly unlink: (path: string) => void;
  readonly mkdir: (path: string) => void;
}

/** What the link step did, and the warnings it gives. */
export interface LinkOutcome {
  readonly status: LinkStatus;
  readonly warnings: readonly SkillsWarning[];
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** The real file system. */
export const REAL_LINK_OPS: LinkOps = {
  platform: process.platform,
  lstat: (path) => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  symlink: (target, path, type) => {
    symlinkSync(target, path, type);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
};

/** A path as it is compared: no `\\?\` prefix, and on Windows no case or separator differences. */
function comparable(path: string, platform: NodeJS.Platform): string {
  const bare = path.startsWith("\\\\?\\") ? path.slice(4) : path;
  return platform === "win32" ? bare.replaceAll("/", "\\").toLowerCase() : bare;
}

const warning = (code: SkillsWarningCode, message: string): SkillsWarning => ({ code, message });

/** The command that makes the link by hand. */
const manualCommand = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? `mklink /J ${CLAUDE_SKILLS_LINK.replaceAll("/", "\\")} ${SKILLS_FOLDER.replaceAll("/", "\\")}`
    : `mkdir -p .claude/skills && ln -s ../../${SKILLS_FOLDER} ${CLAUDE_SKILLS_LINK}`;

const blocked = (reason: string): LinkOutcome => ({
  status: LinkStatus.Blocked,
  warnings: [
    warning(
      SkillsWarningCode.LinkBlocked,
      `${reason} — Claude Code and Cline will not see the agboss skill; move your files out and run npx agboss check`,
    ),
  ],
});

/**
 * The symlink's text: relative, so it survives moving the project — from the real place of its
 * folder, since a relative target is read from there (`.claude/skills` may itself be a link).
 */
const relativeTarget = (path: string, copy: string, ops: LinkOps): string =>
  relative(ops.realpath(dirname(path)) ?? dirname(path), ops.realpath(copy) ?? copy);

/** Makes the link at `path` to `copy`; a failure is a warning with the manual command. */
function create(path: string, copy: string, ops: LinkOps): LinkOutcome {
  try {
    ops.mkdir(dirname(path));
    if (ops.platform === "win32") ops.symlink(copy, path, "junction");
    else ops.symlink(relativeTarget(path, copy, ops), path, "dir");
    return { status: LinkStatus.Linked, warnings: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: LinkStatus.Failed,
      warnings: [
        warning(
          SkillsWarningCode.LinkFailed,
          `${CLAUDE_SKILLS_LINK} not linked: ${reason} — Claude Code and Cline will not see the agboss skill until you run: ${manualCommand(ops.platform)}`,
        ),
      ],
    };
  }
}

/** The existing link at `path`: kept when it is right, replaced when it is agboss's or dangling. */
function checkLink(path: string, copy: string, ops: LinkOps): LinkOutcome {
  const resolved = ops.realpath(path);
  const wanted = ops.realpath(copy);
  if (resolved === undefined) return replaced(path, copy, ops);
  if (
    wanted !== undefined &&
    comparable(resolved, ops.platform) === comparable(wanted, ops.platform)
  )
    return { status: LinkStatus.Current, warnings: [] };
  if (readManifest(resolved) !== undefined) return replaced(path, copy, ops);
  return blocked(`${CLAUDE_SKILLS_LINK} is a link to ${resolved}, not to ${SKILLS_FOLDER} — kept`);
}

function replaced(path: string, copy: string, ops: LinkOps): LinkOutcome {
  try {
    ops.unlink(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: LinkStatus.Failed,
      warnings: [
        warning(
          SkillsWarningCode.LinkFailed,
          `${CLAUDE_SKILLS_LINK} not relinked: ${reason} — remove it and run: ${manualCommand(ops.platform)}`,
        ),
      ],
    };
  }
  return create(path, copy, ops);
}

/** Links `.claude/skills/agboss` to the project's skills folder; never throws. */
export function linkClaudeSkills(root: string, ops: LinkOps = REAL_LINK_OPS): LinkOutcome {
  const path = join(root, CLAUDE_SKILLS_LINK);
  const copy = join(root, SKILLS_FOLDER);
  try {
    const found = ops.lstat(path);
    if (found === undefined) return create(path, copy, ops);
    if (!found.isSymbolicLink()) return blocked(`${CLAUDE_SKILLS_LINK}/ is not managed by agboss`);
    return checkLink(path, copy, ops);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: LinkStatus.Failed,
      warnings: [
        warning(
          SkillsWarningCode.LinkFailed,
          `${CLAUDE_SKILLS_LINK} not linked: ${reason} — run: ${manualCommand(ops.platform)}`,
        ),
      ],
    };
  }
}
