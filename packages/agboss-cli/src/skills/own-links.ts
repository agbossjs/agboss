import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MANIFEST_FILE } from "./manifest.js";
import type { KeptFile } from "./replace.js";
import { SKILLS_FOLDER, SkillsWarningCode, type SkillsWarning } from "./status.js";

/**
 * The project's own links inside `.agents/skills/agboss/` (#1013): a file or folder of the
 * project's that is a symlink is not a file the copy can carry over (copying follows it), so a
 * replace used to drop it without a word. A link that stays inside the project is made again in the
 * new folder with the same text and never followed; one that leaves the project is dropped. Each
 * is named in a warning.
 */

/** What of the project's links the replace keeps, and what is said about every one. */
export interface OwnLinks {
  readonly kept: readonly KeptFile[];
  readonly warnings: readonly SkillsWarning[];
}

/** The links under `folder` (relative, "/"-separated); a link to a folder is not entered. */
function linksUnder(folder: string): string[] {
  const found: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of existsSync(at) ? readdirSync(at, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isSymbolicLink() && `${prefix}${entry.name}` !== MANIFEST_FILE)
        found.push(`${prefix}${entry.name}`);
    }
  };
  walk(folder, "");
  return found.sort();
}

/** True when the link at `path` lands inside the project, judged by its text, nothing followed. */
function staysInside(root: string, path: string): boolean {
  const from = join(root, path);
  const found = relative(root, resolve(dirname(from), readlinkSync(from)));
  return found !== ".." && !found.startsWith(`..${sep}`) && !isAbsolute(found);
}

/** The links of `.agents/skills/agboss/` at `root` that the source does not own, and the warnings. */
export function ownLinksOf(root: string, sourcePaths: readonly string[]): OwnLinks {
  const kept: KeptFile[] = [];
  const warnings: SkillsWarning[] = [];
  const say = (path: string, text: string): void => {
    warnings.push({
      code: SkillsWarningCode.UnmanagedFile,
      message: `${SKILLS_FOLDER}/${path} is a link ${text}; put project rules in AGENTS.md`,
    });
  };
  for (const path of linksUnder(join(root, SKILLS_FOLDER))) {
    const at = join(SKILLS_FOLDER, path);
    if (sourcePaths.some((own) => own === path || own.startsWith(`${path}/`)))
      say(path, "where agboss has a file — replaced by agboss's");
    else if (staysInside(root, at)) {
      kept.push({ from: join(root, at), path, isLink: true });
      say(path, "— kept as it is, not followed");
    } else say(path, "that leaves the project — not kept");
  }
  return { kept, warnings };
}
