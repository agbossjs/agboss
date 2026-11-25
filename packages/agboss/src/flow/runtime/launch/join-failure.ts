import type { RunnableConfig } from "@langchain/core/runnables";
import { errorRecordOf, RecordedError, type ErrorRecord } from "../../../core/error-record.js";
import { valueWrite, type FlowEdge } from "../../analyse/flow-graph.js";
import { compensationsOfFailedJoin, type CompensationEntry } from "../../compensation.js";
import { isSkippedBranch } from "./branch-skip.js";
import { errorHandlerOf } from "../graph-model.js";
import { sidePathEntered } from "../limits.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { handledErrorOf } from "../workflow-keys.js";
import { noticeJoinFailed } from "./join-notices.js";
import type { JoinDeps } from "./join-node.js";
import { finishedOf } from "./join-values.js";
import { joinedValues, type JoinContext } from "./join-write.js";
import { BranchStatus, type BranchOutcomeRecord, type LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";
import { launchPausesOf } from "./withdrawn-pauses.js";

/** A branch's error read back from its record (another process ran it, before a crash). */
class RecordedBranchError extends RecordedError {}

/** A failed branch's error record (a generic one when it has none). */
export const failureRecordOf = (record: BranchOutcomeRecord): ErrorRecord =>
  record.error ?? { name: "Error", code: "Error", lineage: [], message: "failed" };

/**
 * A failed launch: its `.onError(…)` side path, else the branch's error. The side path starts
 * with the answers already settled (#945): the branches that finished, read from the checkpointed
 * records, each as the value of its class — a branch whose undo ran in this failed join is left out.
 */
async function failedJoin(
  launch: RuntimeLaunch,
  failed: {
    readonly record: ErrorRecord;
    readonly node: string;
    readonly state: ExecutionStateType;
    readonly config: RunnableConfig | undefined;
    readonly ticket: LaunchTicket;
    readonly deps: JoinDeps;
    readonly records: readonly BranchOutcomeRecord[];
    readonly undone: readonly string[];
  },
  cause: Error,
): Promise<ExecutionStateUpdate> {
  const { record } = failed;
  const handler = errorHandlerOf({ errors: launch.joinErrors }, record);
  if (handler === undefined) throw cause;
  const handled = handledErrorOf(failed.deps, record, failed.node, handler.to);
  const entered = sidePathEntered(failed.state, record, handler.to, undefined, handled);
  const settled = await settledValues(launch, handler, failed);
  return { ...settled, lastError: record, next: handler.to, handledErrors: [handled], ...entered };
}

/** The settled answers' write onto the side path's scope; nothing when the launch gives no value. */
async function settledValues(
  launch: RuntimeLaunch,
  handler: FlowEdge,
  failed: {
    readonly state: ExecutionStateType;
    readonly config: RunnableConfig | undefined;
    readonly ticket: LaunchTicket;
    readonly deps: JoinDeps;
    readonly records: readonly BranchOutcomeRecord[];
    readonly undone: readonly string[];
  },
): Promise<ExecutionStateUpdate> {
  const groups = handler.settled ?? [];
  const values = groups.flatMap((group) =>
    group.shape === undefined ? [] : [valueWrite(group.shape, false)],
  );
  const gone = new Set(failed.undone);
  const finished = finishedOf(failed.records).filter((record) => {
    const nodeId = failed.ticket.branches[record.index]?.nodeId;
    return nodeId === undefined || !gone.has(nodeId);
  });
  const edge: FlowEdge = {
    ...handler,
    join: { launch: launch.launch, values, groups },
  };
  const context: JoinContext = { state: failed.state, deps: failed.deps };
  const config = failed.config;
  return joinedValues(
    launch,
    edge,
    failed.ticket,
    finished,
    config === undefined ? context : { ...context, config },
  );
}

/**
 * A launch with a failed branch: its finished undoable branches undone first (#340), newest first,
 * then its `.onError(…)` side path, else the branch's error.
 */
export async function failedJoined(
  launch: RuntimeLaunch,
  failed: { readonly record: BranchOutcomeRecord; readonly thrown: unknown },
  site: {
    readonly state: ExecutionStateType;
    readonly config: RunnableConfig | undefined;
    readonly ticket: LaunchTicket;
    readonly deps: JoinDeps;
    readonly records: readonly BranchOutcomeRecord[];
  },
): Promise<ExecutionStateUpdate> {
  const { record, thrown } = failed;
  // the branches that answered are told first (#945): a crash from here runs the join again
  await noticeJoinFailed(launchPausesOf(site.deps.pauses, site.state, site.config), {
    ticket: site.ticket,
    records: site.records,
    errorCode: failureRecordOf(record).code,
  });
  const node = site.ticket.branches[record.index]?.node ?? site.ticket.launcher;
  // the branch's error as it was thrown; read back from its record when another process ran it
  const cause = thrown instanceof Error ? thrown : new RecordedBranchError(failureRecordOf(record));
  const undone = await compensationsOfFailedJoin({ ...site, cause });
  try {
    const undoneNodes = undoneBranchesOf(undone.compensations, site.ticket);
    const failure = failureRecordOf(record);
    const entered = await failedJoin(
      launch,
      { ...site, record: failure, node, undone: undoneNodes },
      cause,
    );
    return { ...undone, ...entered };
  } catch (error) {
    // no side path: the undo's spend reaches no state — the ledger at once (#340 S4)
    await site.deps.limits.budgets.record(undone.usage ?? []);
    throw error;
  }
}

/**
 * The branches of the launch whose entries the join undid, by their node ids: an action's own
 * step, a child workflow's branch by its index (#1281b: its entries are its child's actions').
 */
function undoneBranchesOf(
  entries: readonly CompensationEntry[] | undefined,
  ticket: LaunchTicket,
): readonly string[] {
  return (entries ?? []).flatMap((entry) => {
    if (entry.launchId !== ticket.launchId) return [];
    if (entry.childPath === undefined) return [entry.compensated.nodeId];
    const branch = entry.branchIndex === undefined ? undefined : ticket.branches[entry.branchIndex];
    return branch === undefined ? [] : [branch.nodeId];
  });
}

/**
 * A quorum that cannot be reached fails its launch like a failed branch does (#1281): the join's
 * finished undoable branches are undone first, then `.onError(StepError.QuorumNotReached, …)` starts
 * with the answers settled, else the error is thrown (the undo's spend to the ledger first).
 */
export async function failedQuorum(
  launch: RuntimeLaunch,
  error: Error,
  site: {
    readonly state: ExecutionStateType;
    readonly config: RunnableConfig | undefined;
    readonly ticket: LaunchTicket;
    readonly deps: JoinDeps;
    readonly records: readonly BranchOutcomeRecord[];
  },
): Promise<ExecutionStateUpdate> {
  const record = errorRecordOf(error);
  await noticeJoinFailed(launchPausesOf(site.deps.pauses, site.state, site.config), {
    ticket: site.ticket,
    records: site.records,
    errorCode: record.code,
  });
  const undone = await compensationsOfFailedJoin({ ...site, cause: error });
  try {
    const undoneNodes = undoneBranchesOf(undone.compensations, site.ticket);
    const node = site.ticket.launcher;
    const entered = await failedJoin(launch, { ...site, record, node, undone: undoneNodes }, error);
    return { ...undone, ...entered };
  } catch (thrown) {
    await site.deps.limits.budgets.record(undone.usage ?? []);
    throw thrown;
  }
}

/**
 * The record the launch fails with: the first `Failed` branch — or, in a plain `.join()` whose
 * branch no `skip()` names, an `Expired` one (#945); under a quorum or a `skip()` an expired branch
 * is no failure.
 */
export function failingRecordOf(
  launch: RuntimeLaunch,
  ticket: LaunchTicket,
  records: readonly BranchOutcomeRecord[],
): BranchOutcomeRecord | undefined {
  const failed = records.find((record) => record.status === BranchStatus.Failed);
  if (failed !== undefined || launch.quorum !== undefined) return failed;
  return records.find(
    (record) =>
      record.status === BranchStatus.Expired &&
      !isSkippedBranch(
        ticket.branches[record.index] ?? {},
        record.error ?? failureRecordOf(record),
      ),
  );
}
