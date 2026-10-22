import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the project skills come from (#305): the `skills/agboss/` folder of the `agboss` package the
 * project resolves — the nearest `node_modules/agboss` from the project up (workspaces hoisting,
 * pnpm symlinks) — else of the CLI's own `agboss`. Skills describe the API the project compiles
 * against, so the project's package wins.
 */

/** The skills folder inside the `agboss` package. */
const SKILLS_FOLDER = join("skills", "agboss");

/** One `agboss` package with the skills it ships. */
export interface SkillsSource {
  /** The package's `version`: the version the skills are written for. */
  readonly version: string;
  /** The absolute path of the package's `skills/agboss/`. */
  readonly folder: string;
  /** False when that version ships no skills (an `agboss` older than #305). */
  readonly hasSkills: boolean;
}

/** One file of the skills, by its path inside the skills folder (`references/02-….md`). */
export interface SkillFile {
  /** Relative, with `/` separators on every platform. */
  readonly path: string;
  readonly content: string;
}

/** The `agboss` package Node resolves from `dir`: the nearest `node_modules/agboss` up. */
function agbossPackageFrom(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const manifest = join(at, "node_modules", "agboss", "package.json");
    if (existsSync(manifest)) return realpathSync(dirname(manifest));
    if (dirname(at) === at) return undefined;
  }
}

/** The package's version; a package.json that does not say one is not a source. */
function versionOf(packageFolder: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageFolder, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return undefined;
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** The skills of the `agboss` package in `packageFolder`. */
function sourceIn(packageFolder: string): SkillsSource | undefined {
  const version = versionOf(packageFolder);
  if (version === undefined) return undefined;
  const folder = join(packageFolder, SKILLS_FOLDER);
  return { version, folder, hasSkills: existsSync(join(folder, "SKILL.md")) };
}

/** The `agboss` this CLI is built on (its exact dependency). */
export function cliSkillsSource(): SkillsSource | undefined {
  const found = agbossPackageFrom(dirname(fileURLToPath(import.meta.url)));
  return found === undefined ? undefined : sourceIn(found);
}

/** The skills of the `agboss` the project at `root` resolves, else of the CLI's own. */
export function skillsSourceOf(root: string): SkillsSource | undefined {
  const found = agbossPackageFrom(root);
  return (found === undefined ? undefined : sourceIn(found)) ?? cliSkillsSource();
}

/** Every file of the skills folder, sorted by path. */
export function skillFilesOf(source: SkillsSource): readonly SkillFile[] {
  return filesUnder(source.folder).map((path) => ({
    path,
    content: readFileSync(join(source.folder, path), "utf8"),
  }));
}

/** The paths of every file under `folder`, relative with `/`, sorted. */
export function filesUnder(folder: string): readonly string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}
