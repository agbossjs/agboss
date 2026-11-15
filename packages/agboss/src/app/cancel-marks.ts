import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { rootRecordOf } from "./ended-tree.js";
import type { ExecutionLeases } from "./execution-leases.js";
import type { CancelParts } from "./cancel-requests.js";
import type { TreeState } from "./tree-move-types.js";
import { treeOf } from "./tree-ends.js";

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

/** The statuses of a root whose tree is still alive: moving, or resting at its pause. */
const ALIVE: readonly string[] = [ExecutionRecordStatus.Running, ExecutionRecordStatus.Paused];

/**
 * Whether the tree's cancel mark is set and its root's record is not over: the mark is permanent
 * (#1117) and outlives the tree's end, so a take reads it only for a tree not yet ended — an ended
 * one has its end finished already (#1152).
 */
export async function isMarkedAlive(
  parts: Pick<CancelParts, "deps" | "leases">,
  state: TreeState,
): Promise<boolean> {
  if (!(await isCancelMarked(parts.leases, treeOf(state)))) return false;
  try {
    const record = await rootRecordOf(parts.deps, state);
    return record !== undefined && ALIVE.includes(record.status);
  } catch {
    return false;
  }
}
