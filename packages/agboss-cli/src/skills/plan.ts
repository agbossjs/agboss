import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf, MANIFEST_FILE, type SkillsManifest } from "./manifest.js";
import { filesUnder, type SkillFile } from "./source.js";
import { SkillsSyncStatus } from "./status.js";

/**
 * What a sync would do (#305), read from the folder, its manifest and the source — nothing written.
 * The version is compared as a plain string: any difference, upgrade or downgrade, replaces the
 * files; at the same version a missing file or a sha256 mismatch repairs that file.
 */
export interface SyncPlan {
  readonly status:
    | SkillsSyncStatus.Current
    | SkillsSyncStatus.Installed
    | SkillsSyncStatus.Updated
    | SkillsSyncStatus.Repaired;
  /** The files to write (all on install and update, the damaged ones on repair). */
  readonly written: readonly string[];
  /** The old manifest's files the source no longer has. */
  readonly removed: readonly string[];
  /** Managed files whose content differs from what the manifest says was written. */
  readonly edited: readonly string[];
  /** Files in the folder that no manifest ever listed: the project's own, kept. */
  readonly unmanaged: readonly string[];
}

/** The hash of a file in the folder; undefined when it is not there. */
const diskHashOf = (folder: string, path: string): string | undefined => {
  const file = join(folder, path);
  return existsSync(file) ? hashOf(readFileSync(file, "utf8")) : undefined;
};

/** The files at the same version that are missing or differ from the source. */
const damagedOf = (target: string, files: readonly SkillFile[]): string[] =>
  files
    .filter((file) => diskHashOf(target, file.path) !== hashOf(file.content))
    .map((file) => file.path);

/** The plan for the folder `target`, its manifest (if any) and the source's `files` of `version`. */
export function planSync(
  target: string,
  manifest: SkillsManifest | undefined,
  files: readonly SkillFile[],
  version: string,
): SyncPlan {
  const managed = manifest?.files ?? {};
  const sourcePaths = new Set(files.map((file) => file.path));
  const onDisk = filesUnder(target).filter((path) => path !== MANIFEST_FILE);
  const edited = Object.entries(managed)
    .filter(([path, hash]) => {
      const found = diskHashOf(target, path);
      return found !== undefined && found !== hash;
    })
    .map(([path]) => path);
  const removed = Object.keys(managed).filter((path) => !sourcePaths.has(path));
  const unmanaged = onDisk.filter((path) => !(path in managed) && !sourcePaths.has(path));
  const all = files.map((file) => file.path);
  if (manifest === undefined)
    return { status: SkillsSyncStatus.Installed, written: all, removed, edited, unmanaged };
  if (manifest.version !== version)
    return { status: SkillsSyncStatus.Updated, written: all, removed, edited, unmanaged };
  const damaged = damagedOf(target, files);
  const status =
    damaged.length === 0 && removed.length === 0
      ? SkillsSyncStatus.Current
      : SkillsSyncStatus.Repaired;
  return { status, written: damaged, removed, edited, unmanaged };
}
