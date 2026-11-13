import {
  LinkStatus,
  SkillsSyncStatus,
  type SkillsSync,
  type SkillsSyncResult,
  type SkillsWarning,
} from "./status.js";

/** What a sync prints (#305, #983): its warnings, then one line of what it wrote or linked. */

const countOf = (files: readonly string[]): string =>
  `${String(files.length)} file${files.length === 1 ? "" : "s"}`;

/** The line for a copy that was written; none when it was current, off or not synced. */
function copyLine(result: SkillsSyncResult): string | undefined {
  const written = countOf(result.written);
  switch (result.status) {
    case SkillsSyncStatus.Installed:
      return `skills: ${result.folder} installed for agboss ${result.version ?? ""} (${written})`;
    case SkillsSyncStatus.Updated:
      return `skills: ${result.folder} updated ${result.previous ?? "?"} → ${result.version ?? ""} (${written})`;
    case SkillsSyncStatus.Repaired:
      return `skills: ${result.folder} repaired (${countOf([...result.written, ...result.removed])})`;
    case SkillsSyncStatus.Current:
    case SkillsSyncStatus.Off:
    case SkillsSyncStatus.Failed:
      return undefined;
    default: {
      const unknown: never = result.status;
      return unknown;
    }
  }
}

/** The line a sync prints: what it wrote, with ` · linked …` when it made the link; none when nothing happened. */
function statusLine(result: SkillsSyncResult): string | undefined {
  const link = result.link;
  const linked = link?.status === LinkStatus.Linked ? link.path : undefined;
  const line = copyLine(result);
  if (line === undefined) return linked === undefined ? undefined : `skills: linked ${linked}`;
  return linked === undefined ? line : `${line} · linked ${linked}`;
}

/** A warning as the CLI prints it and `--json` lists it: `[skills.local-edit] …`. */
export const skillsWarningText = (warning: SkillsWarning): string =>
  `[${warning.code}] ${warning.message}`;

/** What a sync prints: its warnings, then what it wrote. */
export function skillsLines(sync: SkillsSync): readonly string[] {
  const line = statusLine(sync.result);
  return [
    ...sync.warnings.map((warning) => `warning: ${skillsWarningText(warning)}`),
    ...(line === undefined ? [] : [line]),
  ];
}
