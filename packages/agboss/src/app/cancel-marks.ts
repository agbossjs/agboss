import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ExecutionLeases } from "./execution-leases.js";

/**
 * Whether the tree's cancel mark is on its lease row (#1152, #1117): the durable request itself,
 * written before the tree key, so a cancel that died between the two left only the mark. A store
 * error reads as none (asked again later).
 */
export async function isCancelMarked(
  leases: ExecutionLeases,
  tree: ExecutionTree,
): Promise<boolean> {
  try {
    return await leases.isCancelRequested(tree);
  } catch {
    return false;
  }
}
