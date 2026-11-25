import type { PauseTargetOverlay, PauseTargetOverrides } from "../channels/pause-targets.js";
import type { FoldedConfig } from "./fold-config.js";

/** What the folded profiles change of the pause targets, tool approvals' and external tasks' together, by name; `undefined` when nothing. */
export function pauseOverridesOf(folded: FoldedConfig): PauseTargetOverrides | undefined {
  const entries: [string, PauseTargetOverlay][] = [
    ...Object.entries(folded.toolApprovals),
    ...Object.entries(folded.externalTasks),
  ];
  return entries.length === 0 ? undefined : new Map(entries);
}
