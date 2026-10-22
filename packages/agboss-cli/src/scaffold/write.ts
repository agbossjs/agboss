import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ScaffoldConflictError, ScaffoldError } from "./errors.js";
import { formatFiles } from "./format.js";
import { keepWiring } from "./keep-wiring.js";

export interface FileToWrite {
  /** relative to the project root */
  readonly path: string;
  readonly content: string;
  /** wirings left out because they are already there (#197): reported, never doubled */
  readonly skipped?: readonly string[];
  /** Written as is, never formatted (the project skills, whose hashes `agboss check` compares). */
  readonly isVerbatim?: boolean;
}

/** What a command changes: new files (must not exist) and existing files it rewires. */
export interface Changes {
  readonly create: readonly FileToWrite[];
  readonly modify: readonly FileToWrite[];
}

export interface ApplyOptions {
  /**
   * Regenerate files that exist: the wiring already in them is kept (#237), wiring the plan would add
   * again is left out (reported as skipped).
   */
  readonly force?: boolean | undefined;
  /** With `force`: overwrite existing files as generated, dropping the wiring in them. */
  readonly reset?: boolean | undefined;
}

/** What was written; `skipped`: wirings already there, `kept`: wiring kept in regenerated files. */
export interface Applied {
  readonly created: string[];
  readonly modified: string[];
  readonly skipped: string[];
  readonly kept: string[];
}

export const skippedOf = (changes: Changes): string[] =>
  [...changes.create, ...changes.modify].flatMap((file) => file.skipped ?? []);

const FORCE_HINT = " — rerun with --force to regenerate the files and keep the existing wiring";

/** Files that exist or wiring that is there → a conflict, unless `force`. */
function conflicts(root: string, changes: Changes, force: boolean): void {
  const clashes = changes.create
    .filter((file) => existsSync(join(root, file.path)))
    .map((file) => file.path);
  const wired = skippedOf(changes);
  if (force || (clashes.length === 0 && wired.length === 0)) return;
  const parts = [
    ...(clashes.length === 0 ? [] : [`Already exists: ${clashes.join(", ")}`]),
    ...(wired.length === 0 ? [] : [`Already wired: ${wired.join("; ")}`]),
  ];
  throw new ScaffoldConflictError(`${parts.join(". ")}. Nothing was written${FORCE_HINT}`);
}

/** `--force` without `--reset`: a new file that exists keeps the wiring the old one has (#237). */
function keepingWiring(root: string, changes: Changes, options: ApplyOptions) {
  if (options.force !== true || options.reset === true) return { changes, kept: [] };
  const results = changes.create.map((file) => {
    const target = join(root, file.path);
    return existsSync(target)
      ? keepWiring(readFileSync(target, "utf8"), file)
      : { file, kept: [] as readonly string[] };
  });
  return {
    changes: { ...changes, create: results.map((r) => r.file) },
    kept: results.flatMap((r) => r.kept),
  };
}

const unchanged = (root: string, file: FileToWrite): boolean =>
  existsSync(join(root, file.path)) && readFileSync(join(root, file.path), "utf8") === file.content;

/**
 * All or nothing: any new file that already exists, or any wiring already there, → an error and
 * nothing is written (AC3), unless `force` — then existing files are regenerated keeping their wiring
 * (or refused when it cannot be kept), unless `reset` too. Written files are formatted with prettier.
 */
export async function apply(
  root: string,
  planned: Changes,
  options: ApplyOptions = {},
): Promise<Applied> {
  conflicts(root, planned, options.force === true);
  const { changes, kept } = keepingWiring(root, planned, options);
  const missing = changes.modify
    .filter((file) => !existsSync(join(root, file.path)))
    .map((file) => file.path);
  if (missing.length > 0)
    throw new ScaffoldError(`Not found, nothing was written: ${missing.join(", ")}`);
  const formatted = await formatFiles(root, [...changes.create, ...changes.modify]);
  const created = formatted.slice(0, changes.create.length);
  const modified = formatted.slice(changes.create.length).filter((f) => !unchanged(root, f));
  for (const file of [...created, ...modified]) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return {
    created: created.map((file) => file.path),
    modified: modified.map((file) => file.path),
    skipped: skippedOf(changes),
    kept,
  };
}

/** `apply`, answering every path it wrote. */
export async function applyChanges(
  root: string,
  changes: Changes,
  options: ApplyOptions = {},
): Promise<string[]> {
  const applied = await apply(root, changes, options);
  return [...applied.created, ...applied.modified];
}
