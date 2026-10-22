import { AGBossError, ExecutionCancelledError } from "../../../core/errors.js";
import type {
  ExecutionTree,
  ExecutionTreeRepository,
  ExecutionTreeValue,
} from "../../../infrastructure/execution-tree.repository.js";
import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
  type CompensationRecord,
} from "../../compensation.js";
import { compensationKeyOf } from "../../context/idempotency.js";
import { ComponentKind } from "../records.js";

/**
 * The durability of an automatic undo (#340 PR 4, AC4): reserved keys of the tree's shared
 * `ExecutionTreeRepository` (`@agboss/` keys belong to the framework, #360 S1) — `@agboss/unwinding`
 * (`{ reason, cause }`) written before a root's undo starts, `@agboss/unwinding:<childExecutionId>`
 * before a child's, and `@agboss/compensated/<compensationKey>` after each undo that succeeded. An
 * instance that takes the tree over after a crash, a lost lease or a stop finds the undo under way
 * and finishes it, skipping the undos marked done. The keys go with the tree's others when it ends.
 */

/** The key of a root's undo under way. */
export const UNWINDING_KEY = "@agboss/unwinding";

/** The key of a child's undo under way. */
export const childUnwindingKeyOf = (childExecutionId: string): string =>
  `${UNWINDING_KEY}:${childExecutionId}`;

/** The key of one undo that succeeded: its automatic undo's own key. */
export const compensatedKeyOf = (compensatedStepKey: string): string =>
  `@agboss/compensated/${compensationKeyOf(compensatedStepKey)}`;

/** The error an undo under way ends with, as its mark keeps it. */
export interface UnwindingCause {
  readonly name: string;
  readonly message: string;
}

/** An undo under way: why it runs, and the error its execution ends with. */
export interface UnwindingMark {
  readonly reason: CompensationReason;
  readonly cause: UnwindingCause;
}

/** Where one unwind keeps its marks: the tree's store, and its own key. */
export interface UnwindMarks {
  readonly trees: ExecutionTreeRepository;
  readonly tree: ExecutionTree;
  /** `UNWINDING_KEY` for a root, `childUnwindingKeyOf(…)` for a child. */
  readonly key: string;
}

/** Why an execution that ended without a finish is undone: cancelled, or failed. */
export const reasonOfCause = (cause: unknown): CompensationReason =>
  cause instanceof ExecutionCancelledError
    ? CompensationReason.ExecutionCancelled
    : CompensationReason.ExecutionFailed;

/** The mark of an undo of an execution that ends with `cause`. */
export function unwindingMarkOf(cause: unknown): UnwindingMark {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return { reason: reasonOfCause(cause), cause: { name: error.name, message: error.message } };
}

/** Records the undo under way (a mark already there is kept: the first reason wins). */
export async function markUnwinding(marks: UnwindMarks, mark: UnwindingMark): Promise<void> {
  const value = {
    reason: mark.reason,
    cause: { name: mark.cause.name, message: mark.cause.message },
  };
  await marks.trees.saveIfAbsentInTree(marks.tree, marks.key, value);
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REASONS: readonly unknown[] = Object.values(CompensationReason);

const isReason = (value: unknown): value is CompensationReason => REASONS.includes(value);

/** The mark the store holds (its boundary: checked, not cast); `undefined` when none. */
function markOf(value: ExecutionTreeValue | undefined): UnwindingMark | undefined {
  if (!isRecord(value) || !isRecord(value.cause) || !isReason(value.reason)) return undefined;
  const { name, message } = value.cause;
  if (typeof name !== "string" || typeof message !== "string") return undefined;
  return { reason: value.reason, cause: { name, message } };
}

/** The undo under way under `key` of the tree; `undefined` when there is none. */
export async function unwindingOf(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
  key: string,
): Promise<UnwindingMark | undefined> {
  return markOf(await trees.findByIdInTree(tree, key));
}

/**
 * The error the execution ends with, rebuilt from its mark by another instance: a cancel is an
 * `ExecutionCancelledError`, a failure an `AGBossError` with the original's message.
 */
export const causeOfMark = (mark: UnwindingMark): AGBossError =>
  mark.reason === CompensationReason.ExecutionCancelled
    ? new ExecutionCancelledError(mark.cause.message)
    : new AGBossError(mark.cause.message);

/** Marks an undo that succeeded as done; a failed one is not marked (it runs again). */
export async function markUndone(marks: UnwindMarks, entry: CompensationEntry): Promise<void> {
  const { undo } = entry;
  if (undo?.status !== CompensationStatus.Compensated) return;
  const { name, schemaHash } = undo.compensator;
  const value = {
    compensator: name,
    schemaHash: schemaHash ?? null,
    reason: undo.reason,
    startedAt: undo.startedAt,
    endedAt: undo.endedAt,
  };
  await marks.trees.saveIfAbsentInTree(marks.tree, compensatedKeyOf(entry.key), value);
}

/** The record of a done undo, from its mark; `undefined` when the entry has none. */
function recordOf(entry: CompensationEntry, value: unknown): CompensationRecord | undefined {
  if (!isRecord(value) || typeof value.compensator !== "string" || !isReason(value.reason))
    return undefined;
  const { startedAt, endedAt, schemaHash } = value;
  if (typeof startedAt !== "string" || typeof endedAt !== "string") return undefined;
  return {
    compensated: entry.compensated,
    compensator: {
      name: value.compensator,
      kind: ComponentKind.Action,
      promptHash: undefined,
      schemaHash: typeof schemaHash === "string" ? schemaHash : undefined,
    },
    reason: value.reason,
    status: CompensationStatus.Compensated,
    startedAt,
    endedAt,
  };
}

/** The entries with each open one an earlier pass undid marked closed (its record from its mark). */
export async function withUndoneMarks(
  marks: UnwindMarks,
  entries: readonly CompensationEntry[],
): Promise<readonly CompensationEntry[]> {
  const read = async (entry: CompensationEntry): Promise<CompensationEntry> => {
    if (entry.status !== CompensationEntryStatus.Open) return entry;
    const value = await marks.trees.findByIdInTree(marks.tree, compensatedKeyOf(entry.key));
    const undo = recordOf(entry, value);
    return undo === undefined ? entry : { ...entry, status: CompensationEntryStatus.Closed, undo };
  };
  return Promise.all(entries.map(read));
}
