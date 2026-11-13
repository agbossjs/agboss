import { join } from "node:path";
import type { LinkOps } from "./link.js";
import {
  assertCarryable,
  carryOver,
  legacyOf,
  legacyPlanOf,
  removeLegacy,
  type Legacy,
  type LegacyPlan,
} from "./migrate.js";
import { readManifest } from "./manifest.js";
import { planSync, type SyncPlan } from "./plan.js";
import { replaceSkillsFolder, type KeptFile, type ReplaceOps } from "./replace.js";
import type { SkillFile } from "./source.js";
import {
  CLAUDE_SKILLS_LINK,
  SKILLS_FOLDER,
  SkillsSyncStatus,
  SkillsWarningCode,
  type SkillsSyncResult,
  type SkillsWarning,
} from "./status.js";

/** Writing the copy `.agents/skills/agboss/` (#305), and moving a 0.1.x folder into it (#983). */

/** The warnings of a plan that writes: hand edits replaced, the project's own files kept. */
function planWarnings(plan: SyncPlan, version: string): SkillsWarning[] {
  return [
    ...plan.edited.map((path) => ({
      code: SkillsWarningCode.LocalEdit,
      message: `${SKILLS_FOLDER}/${path} was edited — replaced by agboss ${version}'s; put project rules in AGENTS.md`,
    })),
    ...plan.unmanaged.map((path) => ({
      code: SkillsWarningCode.UnmanagedFile,
      message: `${SKILLS_FOLDER}/${path} is not agboss's — kept; put project rules in AGENTS.md`,
    })),
  ];
}

/** The result of a plan, as `--json` carries it. */
const resultOf = (plan: SyncPlan, version: string, previous?: string): SkillsSyncResult => ({
  status: plan.status,
  version,
  ...(previous === undefined || previous === version ? {} : { previous }),
  folder: SKILLS_FOLDER,
  written: plan.written,
  removed: plan.removed,
});

/** What writing the copy (and moving the old folder) did. */
export interface CopyOutcome {
  readonly result: SkillsSyncResult;
  readonly warnings: readonly SkillsWarning[];
  /** The old `.claude/skills/agboss/` could not be removed: no link until the next run. */
  readonly isMoveOpen: boolean;
}

const keptOf = (target: string, paths: readonly string[]): KeptFile[] =>
  paths.map((path) => ({ from: join(target, path), path }));

/** The copy of a project with no 0.1.x folder to move: written when it differs from the source. */
function syncInPlace(
  target: string,
  files: readonly SkillFile[],
  version: string,
  replace: ReplaceOps,
): CopyOutcome {
  const manifest = readManifest(target);
  const plan = planSync(target, manifest, files, version);
  const result = resultOf(plan, version, manifest?.version);
  if (plan.status === SkillsSyncStatus.Current) return { result, warnings: [], isMoveOpen: false };
  replaceSkillsFolder(target, files, version, keptOf(target, plan.unmanaged), replace);
  return { result, warnings: planWarnings(plan, version), isMoveOpen: false };
}

/** The result of a fresh move: the old folder's plan, every file written. */
function movedResultOf(
  old: LegacyPlan,
  files: readonly SkillFile[],
  version: string,
  previous: string,
): SkillsSyncResult {
  const status =
    old.plan.status === SkillsSyncStatus.Current ? SkillsSyncStatus.Installed : old.plan.status;
  const written = files.map((file) => file.path);
  return resultOf({ ...old.plan, status, written }, version, previous);
}

/**
 * Moves a managed 0.1.x `.claude/skills/agboss/` into the copy. A fresh move writes the copy from
 * the old folder's plan; an interrupted one (the copy has a manifest) lets `.agents` win and only
 * carries over the old folder's own files. The old folder goes last.
 */
function moveLegacy(
  target: string,
  legacy: Extract<Legacy, { kind: "managed" }>,
  files: readonly SkillFile[],
  version: string,
  replace: ReplaceOps,
): CopyOutcome {
  const manifest = readManifest(target);
  const plan = planSync(target, manifest, files, version);
  const old = legacyPlanOf(legacy, files, version);
  const own = keptOf(target, plan.unmanaged);
  if (manifest === undefined) {
    const kept = [...old.kept, ...own.filter((k) => !old.kept.some((o) => o.path === k.path))];
    replaceSkillsFolder(target, files, version, kept, replace);
  } else {
    assertCarryable(target, old.kept);
    if (plan.status !== SkillsSyncStatus.Current)
      replaceSkillsFolder(target, files, version, own, replace);
    carryOver(target, old.kept);
  }
  const removal = removeLegacy(legacy.folder, replace);
  const isMoved = removal.some((warning) => warning.code === SkillsWarningCode.Moved);
  const base =
    manifest === undefined
      ? movedResultOf(old, files, version, legacy.manifest.version)
      : resultOf(plan, version, manifest.version);
  const isRewritten = manifest !== undefined && plan.status !== SkillsSyncStatus.Current;
  return {
    result: isMoved ? { ...base, moved: { from: CLAUDE_SKILLS_LINK } } : base,
    warnings: [
      ...(isRewritten ? planWarnings(plan, version) : []),
      ...planWarnings(old.plan, version),
      ...removal,
    ],
    isMoveOpen: !isMoved,
  };
}

/** Makes the copy equal to the source; a 0.1.x folder at the old path is moved into it. */
export function syncCopy(
  root: string,
  files: readonly SkillFile[],
  version: string,
  deps: { readonly link: LinkOps; readonly replace: ReplaceOps },
): CopyOutcome {
  const target = join(root, SKILLS_FOLDER);
  const legacy = legacyOf(root, deps.link);
  return legacy.kind === "managed"
    ? moveLegacy(target, legacy, files, version, deps.replace)
    : syncInPlace(target, files, version, deps.replace);
}
