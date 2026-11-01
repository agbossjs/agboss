import { AGBossError, ExecutionCancelledError } from "../../../core/errors.js";
import {
  durableRecordOf,
  errorRecordFromDurable,
  errorRecordOf,
  RecordedError,
  type ErrorRecord,
} from "../../../core/error-record.js";
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

/**
 * The key of a child's failure claimed for its announcement (#596): the one pass whose
 * `saveIfAbsentInTree` wins announces it; the failure is then the child's end — a re-entry repeats
 * it (`UnwindingMark`'s shape: why, and the error by name and message) and never runs its step again.
 */
export const childFailureKeyOf = (childExecutionId: string): string =>
  `@agboss/child-failure:${childExecutionId}`;

/** Claims the announcement of a child's failure (#596): `true` for the one pass that may announce it. */
export async function claimChildFailure(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
  childExecutionId: string,
  cause: unknown,
): Promise<boolean> {
  const value = markValueOf(unwindingMarkOf(cause));
  return trees.saveIfAbsentInTree(tree, childFailureKeyOf(childExecutionId), value);
}

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
  /**
   * The error's record (#598): its class line by code and its causes, so another instance routes
   * the failure it rebuilds as the original was routed. None in a mark written before #598.
   */
  readonly error?: ErrorRecord;
}

/** Where one unwind keeps its marks: the tree's store (none: no marks are kept), and its own key. */
export interface UnwindMarks {
  readonly trees: ExecutionTreeRepository | undefined;
  readonly tree: ExecutionTree;
  /** `UNWINDING_KEY` for a root, `childUnwindingKeyOf(…)` for a child. */
  readonly key: string;
}

/** Where the undos done are marked: the tree's store (none: no marks are kept) and the tree. */
export type UndoneMarks = Pick<UnwindMarks, "trees" | "tree">;

/** Why an execution that ended without a finish is undone: cancelled, or failed. */
export const reasonOfCause = (cause: unknown): CompensationReason =>
  cause instanceof ExecutionCancelledError
    ? CompensationReason.ExecutionCancelled
    : CompensationReason.ExecutionFailed;

/** The mark of an undo of an execution that ends with `cause`. */
export function unwindingMarkOf(cause: unknown): UnwindingMark {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const cut = { name: error.name, message: error.message };
  return { reason: reasonOfCause(cause), cause: cut, error: errorRecordOf(cause) };
}

/** A mark as the tree's store keeps it. */
const markValueOf = (mark: UnwindingMark): ExecutionTreeValue => ({
  reason: mark.reason,
  cause: { name: mark.cause.name, message: mark.cause.message },
  ...(mark.error === undefined ? {} : { error: durableRecordOf(mark.error) }),
});

/** Records the undo under way (a mark already there is kept: the first reason wins). */
export async function markUnwinding(marks: UnwindMarks, mark: UnwindingMark): Promise<void> {
  await marks.trees?.saveIfAbsentInTree(marks.tree, marks.key, markValueOf(mark));
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
  const error = errorRecordFromDurable(value.error);
  return {
    reason: value.reason,
    cause: { name, message },
    ...(error === undefined ? {} : { error }),
  };
}

/** The undo under way under `key` of the tree; `undefined` when there is none. */
export async function unwindingOf(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
  key: string,
): Promise<UnwindingMark | undefined> {
  return markOf(await trees.findByIdInTree(tree, key));
}

/** Whether a root's undo is under way in the tree (a store error is thrown: asked again later). */
export async function isUnwinding(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
): Promise<boolean> {
  return (await unwindingOf(trees, tree, UNWINDING_KEY)) !== undefined;
}

/**
 * The error the execution ends with, rebuilt from its mark by another instance: a cancel is an
 * `ExecutionCancelledError`; a failure a `RecordedError` of its record (#598), which `.onError`
 * routes as the original — the same side path on every holder; a mark written before #598 (no
 * record) an `AGBossError` with the original's message, on every instance alike.
 */
export function causeOfMark(mark: UnwindingMark): Error {
  if (mark.reason === CompensationReason.ExecutionCancelled)
    return new ExecutionCancelledError(mark.cause.message);
  return mark.error === undefined
    ? new AGBossError(mark.cause.message)
    : new RecordedError(mark.error);
}

/** Marks an undo that succeeded as done; a failed one is not marked (it runs again). */
export async function markUndone(marks: UndoneMarks, entry: CompensationEntry): Promise<void> {
  const { undo } = entry;
  const { trees } = marks;
  if (trees === undefined || undo?.status !== CompensationStatus.Compensated) return;
  const { name, schemaHash } = undo.compensator;
  const value = {
    compensator: name,
    schemaHash: schemaHash ?? null,
    reason: undo.reason,
    startedAt: undo.startedAt,
    endedAt: undo.endedAt,
  };
  await trees.saveIfAbsentInTree(marks.tree, compensatedKeyOf(entry.key), value);
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
  marks: UndoneMarks,
  entries: readonly CompensationEntry[],
): Promise<readonly CompensationEntry[]> {
  const { trees } = marks;
  if (trees === undefined) return entries;
  const read = async (entry: CompensationEntry): Promise<CompensationEntry> => {
    if (entry.status !== CompensationEntryStatus.Open) return entry;
    const value = await trees.findByIdInTree(marks.tree, compensatedKeyOf(entry.key));
    const undo = recordOf(entry, value);
    return undo === undefined ? entry : { ...entry, status: CompensationEntryStatus.Closed, undo };
  };
  return Promise.all(entries.map(read));
}
