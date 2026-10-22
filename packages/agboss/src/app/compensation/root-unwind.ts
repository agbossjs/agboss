import { meterOf } from "../../budgets/execution-budgets.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import type { UsageRecord } from "../../finops/usage.js";
import {
  CompensationFailedError,
  CompensationReason,
  compensationRecordsOf,
  hasUndoableActions,
  type CompensationEntry,
  type CompensationRecord,
} from "../../flow/compensation.js";
import { entriesInCheckpoint } from "../../flow/runtime/compensation/checkpoint-entries.js";
import { mergedEntries, unwound } from "../../flow/runtime/compensation/unwind.js";
import { COMPENSATION_TIMEOUT } from "../../flow/compensation.js";
import { systemClock } from "../../infrastructure/clock.js";
import { NodeKind } from "../../flow/ast.js";
import type { GraphDeps } from "../../graph/deps.js";
import { runConfig } from "../../run/paused.js";
import type { AppDeps } from "../app-deps.js";
import { treeStateOf, type TreeState as CheckpointState } from "../pause-frame.js";
import { treeOf } from "../tree-ends.js";
import type { TreeState } from "../tree-move-types.js";
import { undoSiteOf, type TreeUndoSites } from "./tree-undo-sites.js";

/**
 * The automatic undo of a tree that ends without a finish (#340 PR 3, Q2 / Q6): its pass rejected
 * (an uncaught failure or limit, a cancel — local, or another instance's request), or a paused tree
 * is cancelled. Run by the lease's holder before the tree's keys are removed and `onExecutionError`
 * is observed: first the tree's running step bodies are awaited (children still undoing in this
 * process among them, Q-A, up to `compensationTimeout`), then every open entry of the tree — the
 * root's, and a descendant's no child node undid here (a paused child) — is undone newest first,
 * from its checkpoint (pending writes applied, Q-C) merged with the instance registry (S2); the
 * tree is sealed for a body that returns later (Q-B). The undo's spend is written to the ledger at
 * once. A failing undo makes the tree's error `CompensationFailedError` (its cause the original).
 */

/** Why the tree ends, and the lease's signal its undo runs under. */
export interface TreeUnwindCall {
  readonly cause: unknown;
  readonly signal: AbortSignal;
}

/** What the tree's end raises and the undo records its error event carries. */
export interface TreeUnwound {
  readonly error: unknown;
  readonly compensations: readonly CompensationRecord[];
}

/** Every entry the tree's checkpoint holds (its root's and its descendants'), with their namespaces. */
async function checkpointOf(deps: AppDeps, state: TreeState) {
  const namespaces = new Map<string, string>();
  const saver = deps.pause?.checkpointer;
  if (saver === undefined) return { entries: [], namespaces };
  const found = await entriesInCheckpoint(saver, runConfig(state.runId), state.runId);
  for (const each of found) namespaces.set(each.executionId, each.namespace);
  return { entries: found.flatMap((each) => each.entries), namespaces };
}

/** Whether a workflow of the tree (its own, or a child's at any depth) declares an undo. */
function treeHasUndoableActions(deps: GraphDeps<string>, seen = new Set<string>()): boolean {
  if (seen.has(deps.config.name)) return false;
  seen.add(deps.config.name);
  if (hasUndoableActions(deps.graph)) return true;
  return [...deps.graph.nodes.values()].some((node) => {
    const child = node.kind === NodeKind.Workflow ? deps.childDepsOf?.(node.component) : undefined;
    return child !== undefined && treeHasUndoableActions(child, seen);
  });
}

/** Writes the undo's spend to the execution's budgets' counters at once. */
async function recordAtOnce(
  deps: AppDeps,
  checkpoint: CheckpointState,
  usage: readonly UsageRecord[],
): Promise<void> {
  if (deps.budgets === undefined || usage.length === 0) return;
  await meterOf(deps.budgets, checkpoint.budgets ?? [], 0).record(usage);
}

/** The records of the root's error event: its undos before the end, then the end's, as they ran. */
function recordsOf(
  state: TreeState,
  known: readonly CompensationEntry[],
  closed: readonly CompensationEntry[],
): readonly CompensationRecord[] {
  const keys = new Set(closed.map((entry) => entry.key));
  const before = known.filter((entry) => entry.executionId === state.runId && !keys.has(entry.key));
  return compensationRecordsOf([...before, ...closed]);
}

/** Undoes the tree's open entries; what its end raises. */
export async function unwoundTree(
  deps: AppDeps,
  state: TreeState,
  call: TreeUnwindCall,
): Promise<TreeUnwound> {
  if (!treeHasUndoableActions(deps)) return { error: call.cause, compensations: [] };
  const tree = treeOf(state);
  const checkpoint = await treeStateOf(deps, state.runId);
  const stored = await checkpointOf(deps, state);
  const mirrored = deps.compensation?.registry.entriesOf(tree, () => true) ?? [];
  const owner = await deps.terns.threadOwner(deps.config.name, state.tenantId, state.threadId);
  const isCancelled = call.cause instanceof ExecutionCancelledError;
  const sites: TreeUndoSites = {
    ...{ deps, state, checkpoint, ownerId: owner?.owner, signal: call.signal },
    reason: isCancelled
      ? CompensationReason.ExecutionCancelled
      : CompensationReason.ExecutionFailed,
    namespaces: stored.namespaces,
  };
  const record = (usage: readonly UsageRecord[]): Promise<void> =>
    recordAtOnce(deps, checkpoint, usage);
  const done = await unwound({
    tree,
    covers: () => true,
    runs: () => true,
    known: stored.entries,
    undoSiteOf: (entry) => undoSiteOf(sites, entry),
    parts: deps.compensation,
    stepEntries: deps.stepEntries,
    clock: deps.clock ?? systemClock,
    timeout: deps.compensation?.timeout ?? COMPENSATION_TIMEOUT,
    isSealing: true,
    record,
  });
  await record(done.usage);
  const compensations = recordsOf(state, mergedEntries(stored.entries, mirrored), done.closed);
  const error =
    done.failures.length === 0
      ? call.cause
      : new CompensationFailedError(done.failures, call.cause);
  return { error, compensations };
}
