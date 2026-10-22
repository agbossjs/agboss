/** What the sync of a project's skills did (#305), as `--json` carries it in `result.skills`. */

/** The project's skills folder, relative to its root. */
export const SKILLS_FOLDER = ".claude/skills/agboss";

/** What a sync found and did. */
export enum SkillsSyncStatus {
  /** The folder matches the installed `agboss`: nothing written. */
  Current = "current",
  /** The folder (or its manifest) was missing: written. */
  Installed = "installed",
  /** Another `agboss` version than the manifest's: the folder replaced. */
  Updated = "updated",
  /** The same version, a file missing or edited by hand: restored. */
  Repaired = "repaired",
  /** `"agboss": { "skills": false }` in package.json: nothing read or written. */
  Off = "off",
  /** Not synced: no `agboss` to take the skills from, or the folder could not be written. */
  Failed = "failed",
}

/** The warnings a sync gives; none of them changes the command's exit code. */
export enum SkillsWarningCode {
  LocalEdit = "skills.local-edit",
  UnmanagedFile = "skills.unmanaged-file",
  SyncFailed = "skills.sync-failed",
  NoFramework = "skills.no-framework",
}

/** One warning of a sync. */
export interface SkillsWarning {
  readonly code: SkillsWarningCode;
  readonly message: string;
}

/** `result.skills` of `agboss check --json` / `agboss generate --json`. */
export interface SkillsSyncResult {
  readonly status: SkillsSyncStatus;
  /** The `agboss` version the folder is now for (unset when off or not synced). */
  readonly version?: string;
  /** The manifest's version before an update. */
  readonly previous?: string;
  readonly folder: string;
  /** The files written, by their path inside the folder (the manifest not counted). */
  readonly written: readonly string[];
  /** The files of the old manifest the new version does not have. */
  readonly removed: readonly string[];
}

/** A sync's result and its warnings. */
export interface SkillsSync {
  readonly result: SkillsSyncResult;
  readonly warnings: readonly SkillsWarning[];
}
