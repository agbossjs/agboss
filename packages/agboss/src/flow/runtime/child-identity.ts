import type { ObservabilityMask } from "../../pii/observability-mask.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { extractRunContext, runIdOf, type RunContext } from "../../core/run-context.js";
import type { ExecutionIds } from "../../infrastructure/clock.js";
import { rootFactsOf, type Frame } from "../context/frame.js";
import type { ChildIdentityRecord } from "./child-records.js";
import { childThreadIn, childThreadOf, markerConfigOf, saveChildMarker } from "./child-thread.js";

/**
 * A child execution's identity (#263, ADR-0022): on its first entry the runner makes its id and keeps
 * it, with how much spend it inherited and its own thread, in a marker under the launching task's
 * `checkpoint_ns`; a re-entry after a pause or a crash finds that marker and reads the same id back
 * — no new id, no second `onExecutionStart`. A child that started before ADR-0022 is found the same
 * way, in its own subgraph state there (no thread: S4 D6). Its run context is its parent's
 * (thread, owner, tenant, the launch's signal) with its own id, input and place in the tree.
 */

/** A child's identity, whether this entry is its first, and its own thread (ADR-0022). */
export interface ChildEntered {
  readonly identity: ChildIdentityRecord;
  readonly isNew: boolean;
  /**
   * Its own checkpoint thread; `undefined` for a child that started before ADR-0022 — its state is
   * the subgraph checkpoint under its launching task, and it is continued that way (S4 D6).
   */
  readonly thread?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** A child identity read from a checkpoint (LangGraph boundary: checked, not cast). */
function identityOf(value: unknown): ChildIdentityRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { executionId, parentExecutionId, rootExecutionId, itemIndex, inheritedUsage } = value;
  if (
    typeof executionId !== "string" ||
    typeof parentExecutionId !== "string" ||
    typeof rootExecutionId !== "string" ||
    typeof inheritedUsage !== "number"
  )
    return undefined;
  return {
    executionId,
    parentExecutionId,
    rootExecutionId,
    ...(typeof itemIndex === "number" ? { itemIndex } : {}),
    inheritedUsage,
  };
}

/** What the launching task's namespace holds: a marker (its thread), or an old subgraph state. */
export interface StoredChild {
  readonly identity: ChildIdentityRecord;
  readonly thread?: string;
}

/** The identity the launching task's namespace holds: a marker's, or an old child's own state. */
export async function storedChildOf(
  checkpointer: BaseCheckpointSaver | undefined,
  config: RunnableConfig | undefined,
): Promise<StoredChild | undefined> {
  const at = markerConfigOf(config);
  if (checkpointer === undefined || at === undefined) return undefined;
  const tuple = await checkpointer.getTuple(at);
  const values: unknown = tuple?.checkpoint.channel_values;
  const identity = isRecord(values) ? identityOf(values.child) : undefined;
  if (identity === undefined) return undefined;
  const thread = childThreadIn(values);
  return thread === undefined ? { identity } : { identity, thread };
}

/** Where a child is entered: its parent's frame, its item, and the spend it inherits. */
export interface ChildEntrySpot {
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  readonly config: RunnableConfig | undefined;
  readonly parent: Frame;
  readonly itemIndex: number | undefined;
  readonly inheritedUsage: number;
  /** The application's execution ids (#313, #591): the child's, kept before its marker. */
  readonly executionIds: ExecutionIds;
}

/**
 * The child's identity: read back from its launching task's marker (or an old child's own state),
 * or made now on its first entry — its id kept (#591), its own thread with it, its marker kept
 * before it runs.
 */
export async function childEnteredAt(spot: ChildEntrySpot): Promise<ChildEntered> {
  const stored = await storedChildOf(spot.checkpointer, spot.config);
  if (stored !== undefined) return { ...stored, isNew: false };
  const { execution } = spot.parent;
  // kept before its marker (#591): a child never takes another execution's id; a crash before
  // the marker leaves the id kept and unused — the re-entry makes another
  const executionId = await spot.executionIds.newExecutionId(execution.tenant.tenantId);
  const identity: ChildIdentityRecord = {
    executionId,
    parentExecutionId: execution.executionId,
    rootExecutionId: rootFactsOf(execution).executionId,
    ...(spot.itemIndex === undefined ? {} : { itemIndex: spot.itemIndex }),
    inheritedUsage: spot.inheritedUsage,
  };
  const at = markerConfigOf(spot.config);
  const parentThread: unknown = spot.config?.configurable?.thread_id;
  if (spot.checkpointer === undefined || at === undefined || typeof parentThread !== "string")
    return { identity, isNew: true, thread: childThreadOf("", identity.executionId) };
  const thread = childThreadOf(parentThread, identity.executionId);
  await saveChildMarker(spot.checkpointer, at, { child: identity, childThread: thread });
  return { identity, isNew: true, thread };
}

const objectInput = (input: unknown): Readonly<Record<string, unknown>> =>
  isRecord(input) && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {};

/** The child's run context: its parent's run with its own id, input and place in the tree. */
export function childRunOf(
  config: RunnableConfig | undefined,
  parent: Frame,
  identity: ChildIdentityRecord,
  input: unknown,
  mask: ObservabilityMask | undefined,
): RunContext {
  const { run } = extractRunContext(config, parent.execution.executionId);
  return {
    ...run,
    // what the child's steps store is masked by its own workflow's policies (#505)
    observability: mask,
    runId: runIdOf(identity.executionId),
    input: objectInput(input),
    tree: {
      parent: { execution: parent.execution, step: parent.step },
      itemIndex: identity.itemIndex,
    },
  };
}
