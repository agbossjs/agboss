import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { extractRunContext, runIdOf, type RunContext } from "../../core/run-context.js";
import type { IdGenerator } from "../../infrastructure/clock.js";
import { rootFactsOf, type Frame } from "../context/frame.js";
import type { ChildIdentityRecord } from "./child-records.js";

/**
 * A child execution's identity (#263 S24): on its first entry the runner makes its id and keeps it,
 * with how much spend it inherited, in the child's own state (the subgraph's checkpoint under the
 * launching task's `checkpoint_ns`); a re-entry after a pause or a crash finds that checkpoint and
 * reads the same id back — no new id, no second `onExecutionStart`. Its run context is its parent's
 * (thread, owner, tenant, the launch's signal) with its own id, input and place in the tree.
 */

/** A child's identity, and whether this entry is its first. */
export interface ChildEntered {
  readonly identity: ChildIdentityRecord;
  readonly isNew: boolean;
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

/** The identity the child's checkpoint holds: the launching task's own namespace. */
async function storedIdentity(
  checkpointer: BaseCheckpointSaver | undefined,
  config: RunnableConfig | undefined,
): Promise<ChildIdentityRecord | undefined> {
  const threadId: unknown = config?.configurable?.thread_id;
  const namespace: unknown = config?.configurable?.checkpoint_ns;
  if (checkpointer === undefined || typeof threadId !== "string" || typeof namespace !== "string")
    return undefined;
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: namespace },
  });
  const values: unknown = tuple?.checkpoint.channel_values;
  return isRecord(values) ? identityOf(values.child) : undefined;
}

/** Where a child is entered: its parent's frame, its item, and the spend it inherits. */
export interface ChildEntrySpot {
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  readonly config: RunnableConfig | undefined;
  readonly parent: Frame;
  readonly itemIndex: number | undefined;
  readonly inheritedUsage: number;
  /** The application's id generator (#313): the child's execution id. */
  readonly idGenerator: IdGenerator;
}

/** The child's identity: read back from its checkpoint, or made now on its first entry. */
export async function childEnteredAt(spot: ChildEntrySpot): Promise<ChildEntered> {
  const stored = await storedIdentity(spot.checkpointer, spot.config);
  if (stored !== undefined) return { identity: stored, isNew: false };
  const { execution } = spot.parent;
  const identity: ChildIdentityRecord = {
    executionId: spot.idGenerator.newExecutionId(),
    parentExecutionId: execution.executionId,
    rootExecutionId: rootFactsOf(execution).executionId,
    ...(spot.itemIndex === undefined ? {} : { itemIndex: spot.itemIndex }),
    inheritedUsage: spot.inheritedUsage,
  };
  return { identity, isNew: true };
}

const objectInput = (input: unknown): Readonly<Record<string, unknown>> =>
  isRecord(input) && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {};

/** The child's run context: its parent's run with its own id, input and place in the tree. */
export function childRunOf(
  config: RunnableConfig | undefined,
  parent: Frame,
  identity: ChildIdentityRecord,
  input: unknown,
): RunContext {
  const { run } = extractRunContext(config, parent.execution.executionId);
  return {
    ...run,
    runId: runIdOf(identity.executionId),
    input: objectInput(input),
    tree: {
      parent: { execution: parent.execution, step: parent.step },
      itemIndex: identity.itemIndex,
    },
  };
}
