import type { BudgetOverlay } from "../budgets/budget-overlay.js";
import type { PauseTargetOverlay } from "../channels/pause-targets.js";
import type { MemoryOverlay } from "../memory/memory.decorator.js";
import type { FilePolicyOverlay } from "../files/file-policy.js";
import type { LoadedProfile } from "./config-files.js";

/** The named shelves of the profiles (budgets, memories, storages, mesh, pause targets), each folded left to right. */

/** What each memory keeps, later profiles winning per field. */
export function memoriesOf(
  layers: readonly LoadedProfile[],
): Readonly<Record<string, MemoryOverlay>> {
  const found: Record<string, MemoryOverlay> = {};
  for (const layer of layers)
    for (const [name, one] of Object.entries(layer.spec.memories ?? {}))
      found[name] = { ...found[name], ...one };
  return found;
}

/** What a shelf of named settings says, later profiles winning per field. */
export function foldedShelf<TOverlay extends object>(
  layers: readonly LoadedProfile[],
  shelf: "databaseStorages" | "mesh" | "channels",
): Readonly<Record<string, TOverlay>> {
  const found: Record<string, TOverlay> = {};
  for (const layer of layers) {
    const entries = layer.spec[shelf];
    // a class (`mesh`) or a list of classes (`channels`) replaces the application's own: no shelf of settings
    if (typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, one] of Object.entries(entries))
      found[name] = { ...found[name], ...one } as TOverlay;
  }
  return found;
}

/** What a shelf of pause targets says, later profiles winning per field. */
export function pauseTargetsOf(
  layers: readonly LoadedProfile[],
  shelf: "toolApprovals" | "externalTasks",
): Readonly<Record<string, PauseTargetOverlay>> {
  const found: Record<string, PauseTargetOverlay> = {};
  for (const layer of layers)
    for (const [name, one] of Object.entries(layer.spec[shelf] ?? {}))
      found[name] = { ...found[name], ...one };
  return found;
}

/** The limits of each budget, later profiles winning per limit. */
export function budgetsOf(
  layers: readonly LoadedProfile[],
): Readonly<Record<string, BudgetOverlay>> {
  const found: Record<string, BudgetOverlay> = {};
  for (const layer of layers)
    for (const [name, one] of Object.entries(layer.spec.budgets ?? {}))
      found[name] = { ...found[name], ...one };
  return found;
}

/** What each file policy allows, later profiles winning per field (the fetch pool per pool field). */
export function filePoliciesOf(
  layers: readonly LoadedProfile[],
): Readonly<Record<string, FilePolicyOverlay>> {
  const found: Record<string, FilePolicyOverlay> = {};
  for (const layer of layers)
    for (const [name, one] of Object.entries(layer.spec.filePolicies ?? {}))
      found[name] = {
        ...found[name],
        ...one,
        ...(one.fetchPool === undefined
          ? {}
          : { fetchPool: { ...found[name]?.fetchPool, ...one.fetchPool } }),
      };
  return found;
}
