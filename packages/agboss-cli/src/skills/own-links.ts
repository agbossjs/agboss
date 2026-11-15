import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { MANIFEST_FILE } from "./manifest.js";
import { realPrefix, resolveReal } from "./real-target.js";
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

/**
 * True when the link `file` (its text is read, nothing followed), written at `place`, lands inside
 * the project (#1076, #1107): the root, the place's longest existing parent and the target go
 * through real paths, so `/tmp` and `/private/tmp` agree and a symlinked parent of the place counts.
 * The target is walked one component at a time with every link followed before the next `..`
 * (`real-target.ts`), never collapsed as text. A dangling link is judged by its resolved parent;
 * a loop of links is outside.
 */
export function staysInside(root: string, file: string, place: string): boolean {
  const target = resolveReal(realPrefix(dirname(place)), readlinkSync(file));
  if (target === undefined) return false;
  const found = relative(realpathSync(root), realPrefix(target));
  return found !== ".." && !found.startsWith(`..${sep}`) && !isAbsolute(found);
}

/** The links of `folder` (`.agents/skills/agboss/`, or the 0.1.x one) at `root` that the source does not own, and the warnings. */
export function ownLinksOf(
  root: string,
  sourcePaths: readonly string[],
  folder: string = SKILLS_FOLDER,
): OwnLinks {
  // where a kept link is written: always the new folder, whatever folder it is read from
  const kept: KeptFile[] = [];
  const warnings: SkillsWarning[] = [];
  const say = (path: string, text: string): void => {
    warnings.push({
      code: SkillsWarningCode.UnmanagedFile,
      message: `${folder}/${path} is a link ${text}; put project rules in AGENTS.md`,
    });
  };
  for (const path of linksUnder(join(root, folder))) {
    const at = join(folder, path);
    if (sourcePaths.some((own) => own === path || own.startsWith(`${path}/`)))
      say(path, "where agboss has a file — replaced by agboss's");
    else if (
      staysInside(root, join(root, at), join(root, at)) &&
      staysInside(root, join(root, at), join(root, SKILLS_FOLDER, path))
    ) {
      kept.push({ from: join(root, at), path, isLink: true });
      say(path, "— kept as it is, not followed");
    } else say(path, "that leaves the project — not kept");
  }
  return { kept, warnings };
}
