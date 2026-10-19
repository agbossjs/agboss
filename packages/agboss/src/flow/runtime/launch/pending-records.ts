import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { BranchStatus, type BranchOutcomeRecord } from "./records.js";

/**
 * The records of a launch's branches that finished in the superstep in flight (#279 S26): LangGraph
 * keeps each finished task's writes as the checkpoint's pending writes, so after a crash or a
 * `resume` — when only the unfinished branches run again — a quorum's state is rebuilt from them:
 * its counts, `max(acceptedSequence)`, its verdicts. Read from the checkpoint the superstep started
 * on (the execution's thread, the namespace of its graph — a child's own inside a child workflow);
 * values are checked, not cast (LangGraph boundary).
 */

/** The channel the branches write their records to (`ExecutionState.branchRecords`). */
const CHANNEL = "branchRecords";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const STATUSES: ReadonlySet<unknown> = new Set(Object.values(BranchStatus));

function isOutcomeRecord(value: unknown): value is BranchOutcomeRecord {
  return (
    isRecord(value) &&
    typeof value.launchId === "string" &&
    typeof value.index === "number" &&
    STATUSES.has(value.status)
  );
}

/** The records a pending write adds. */
function addedBy(value: unknown): readonly BranchOutcomeRecord[] {
  if (!isRecord(value) || !Array.isArray(value.add)) return [];
  return (value.add as readonly unknown[]).filter(isOutcomeRecord);
}

/** The execution's checkpoint thread, from the node's config. */
const threadOf = (config: RunnableConfig | undefined): string | undefined => {
  const threadId: unknown = config?.configurable?.thread_id;
  return typeof threadId === "string" ? threadId : undefined;
};

/**
 * The namespace of the graph a node runs in: its task's without the task's own part — `""` at the
 * root, a child workflow's own inside it (#263).
 */
const graphNamespaceOf = (config: RunnableConfig | undefined): string => {
  const namespace: unknown = config?.configurable?.checkpoint_ns;
  return typeof namespace === "string" ? namespace.split("|").slice(0, -1).join("|") : "";
};

/** The pending records of `launchId` in the execution's latest checkpoint; none without one. */
export async function pendingRecordsOf(
  checkpointer: BaseCheckpointSaver | undefined,
  config: RunnableConfig | undefined,
  launchId: string,
): Promise<readonly BranchOutcomeRecord[]> {
  const threadId = threadOf(config);
  if (checkpointer === undefined || threadId === undefined) return [];
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: graphNamespaceOf(config) },
  });
  return (tuple?.pendingWrites ?? []).flatMap(([, channel, value]) =>
    channel === CHANNEL ? addedBy(value).filter((record) => record.launchId === launchId) : [],
  );
}
