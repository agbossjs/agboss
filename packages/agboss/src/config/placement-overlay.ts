import type { ChildPlacement } from "../flow/child-placement.js";
import type { FoldedConfig } from "./fold-config.js";
import { overlaysOf } from "./workflow-overlay.js";

/** The placement the profiles give a workflow as a child: per profile `"*"` then its own, a later one winning. */
export function placementOf(folded: FoldedConfig, workflow: string): ChildPlacement | undefined {
  return overlaysOf(folded, workflow).reduce<ChildPlacement | undefined>(
    (found, overlay) => overlay.overlay.placement ?? found,
    undefined,
  );
}
