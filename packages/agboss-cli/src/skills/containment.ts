import { join, sep } from "node:path";
import type { LinkOps } from "./link.js";
import { SkillsWarningCode, type SkillsWarning } from "./status.js";

/**
 * The guard of every write the skills sync makes (#983): the folders it writes in or removes from
 * must really be inside the project. `lstat` of a last path component does not see a symlinked
 * parent — a cloned repository may ship `.claude -> ~` or `.agents -> /somewhere`, and a move, a
 * swap, a link or a leftover cleanup would then act outside the project. A link that stays inside
 * the project is fine; one that leaves it is refused with a warning and nothing is touched.
 */

/** The folders a sync writes in or reads from, below the root; the ones that exist are checked. */
const GUARDED = [".claude", ".claude/skills", ".agents", ".agents/skills", ".agents/skills/agboss"];

/** A path as it is compared: on Windows case and separators do not matter. */
const comparable = (path: string, platform: NodeJS.Platform): string => {
  const bare = path.startsWith("\\\\?\\") ? path.slice(4) : path;
  return platform === "win32" ? bare.replaceAll("/", "\\").toLowerCase() : bare;
};

/** The first guarded folder (relative to `root`) whose real place is outside the project, if any. */
export function outsideProject(
  root: string,
  ops: Pick<LinkOps, "realpath" | "lstat" | "platform">,
): string | undefined {
  const { platform } = ops;
  const base = comparable(ops.realpath(root) ?? root, platform);
  for (const relative of GUARDED) {
    const real = ops.realpath(join(root, relative));
    // a dangling link would let `mkdir -p` create its target, wherever that is
    if (real === undefined) {
      if (ops.lstat(join(root, relative))?.isSymbolicLink() === true) return relative;
      continue;
    }
    const at = comparable(real, platform);
    if (
      at !== base &&
      !at.startsWith(base.endsWith(sep) ? base : base + (platform === "win32" ? "\\" : sep))
    )
      return relative;
  }
  return undefined;
}

/** The warning for a folder that leaves the project. */
export const outsideWarning = (relative: string): SkillsWarning => ({
  code: SkillsWarningCode.OutsideProject,
  message: `${relative} is a link that leaves the project — skills not synced and nothing touched; remove the link (or point it inside the project) and run npx agboss check`,
});
