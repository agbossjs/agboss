import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import {
  CompensationEntryStatus,
  mergeCompensations,
  type CompensationEntry,
} from "../../compensation.js";
import { childThreadIn } from "../child-thread.js";

/**
 * The one reader of undoable actions from a checkpoint (#340 S3 Q-C): for every execution of a
 * tree on its thread — the root under the namespace `""`, each child under its task's
 * `checkpoint_ns` (a recursive one too: no registered subgraph needed) — the newest checkpoint's
 * `compensations` with the unfinished superstep's pending writes applied (S2: a task that finished
 * before an abort keeps its writes only as pending writes; `task.state` of an errored child is
 * dropped by `getState`, so the tuples are read here, never the snapshot). Shared by recovery and
 * the child unwind (#340 PR 3 / PR 4).
 */

/** One execution's entries as its checkpoint holds them. */
export interface CheckpointEntries {
  /** The execution's `checkpoint_ns`: `""` for the root. */
  readonly namespace: string;
  readonly executionId: string;
  readonly entries: readonly CompensationEntry[];
}

const COMPENSATIONS = "compensations";

const STATUSES: readonly unknown[] = Object.values(CompensationEntryStatus);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** A list the framework wrote into the channel (the checkpoint's boundary: checked, not cast). */
const isEntryList = (value: unknown): value is readonly CompensationEntry[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.key === "string" &&
      typeof entry.sequence === "number" &&
      STATUSES.includes(entry.status),
  );

/** The id of the execution a namespace's checkpoint belongs to, when it is of the tree. */
function executionOf(namespace: string, values: Readonly<Record<string, unknown>>, root: string) {
  if (namespace === "" && values.runId === root) return root;
  // a child's own: on its own thread (ADR-0022), or under its task before it
  const { child } = values;
  if (!isRecord(child) || child.rootExecutionId !== root) return undefined;
  return typeof child.executionId === "string" ? child.executionId : undefined;
}

/** The channel's value with the tuple's pending writes to it applied, in order. */
function entriesOf(tuple: CheckpointTuple): readonly CompensationEntry[] {
  const kept: unknown = tuple.checkpoint.channel_values[COMPENSATIONS];
  let entries: readonly CompensationEntry[] = isEntryList(kept) ? kept : [];
  for (const [, channel, value] of tuple.pendingWrites ?? []) {
    if (channel === COMPENSATIONS && isEntryList(value))
      entries = mergeCompensations(entries, value);
  }
  return entries;
}

/**
 * Every execution of the tree rooted at `rootExecutionId` on the thread of `config`, with its
 * own entries — the newest checkpoint of each namespace; a launching task's marker (ADR-0022)
 * leads to its child's own thread, read the same way.
 */
export async function entriesInCheckpoint(
  saver: BaseCheckpointSaver,
  config: RunnableConfig,
  rootExecutionId: string,
): Promise<readonly CheckpointEntries[]> {
  const seen = new Set<string>();
  const found: CheckpointEntries[] = [];
  const thread = { ...config, configurable: { ...config.configurable, checkpoint_ns: undefined } };
  for await (const tuple of saver.list(thread)) {
    const namespace = String(tuple.config.configurable?.checkpoint_ns ?? "");
    if (seen.has(namespace)) continue;
    seen.add(namespace);
    const values = tuple.checkpoint.channel_values;
    const childThread = childThreadIn(values);
    if (childThread !== undefined) {
      // the child's namespaces read as if it ran under its task: the path of child nodes down
      const own = { configurable: { thread_id: childThread } };
      const inChild = await entriesInCheckpoint(saver, own, rootExecutionId);
      for (const each of inChild) {
        const below = each.namespace === "" ? namespace : `${namespace}|${each.namespace}`;
        found.push({ ...each, namespace: below });
      }
      continue;
    }
    const executionId = executionOf(namespace, values, rootExecutionId);
    if (executionId === undefined) continue;
    // an execution's own entries only: a child's state may start from its parent's values
    const entries = entriesOf(tuple).filter((entry) => entry.executionId === executionId);
    found.push({ namespace, executionId, entries });
  }
  return found;
}
