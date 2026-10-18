import type { RunnableConfig } from "@langchain/core/runnables";
import type { ErrorRecord } from "../../../core/error-record.js";
import { errorHandlerOf, type RuntimeGraph } from "../graph-model.js";
import type { GraphNode } from "../node-runner.js";
import { reportOutdating } from "../outdating-report.js";
import { writeAndOutdate } from "../outdating.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import type { VisitDeps } from "../visit.js";
import { finishedOf, joinValuesOf } from "./join-values.js";
import type { LaunchRegistry } from "./launch-registry.js";
import {
  BranchStatus,
  type BranchOutcomeRecord,
  type LaunchRecord,
  type LaunchTicket,
} from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * The join of a launch (#273 S20): a LangGraph node of its own, run once after every branch ended.
 * It reads only its own launch's records (a launch inside a loop never sees an earlier pass's),
 * drops them, records the launch for `result.launches`, and goes on — on the main path with the
 * branches' values written into the scope at once (one outdating cascade), or, when a branch
 * failed, into the most specific `.onJoinError(E, …)` by the error's class and cause chain. No
 * handler: the execution fails with the branch's error as it was thrown.
 */

export interface JoinDeps extends VisitDeps {
  readonly graph: RuntimeGraph;
  readonly registry: LaunchRegistry;
}

/** A branch's error read back from its record (another process ran it, before a crash). */
class RecordedBranchError extends Error {
  readonly record: ErrorRecord;

  constructor(record: ErrorRecord) {
    super(record.message);
    this.name = record.name;
    this.record = record;
  }
}

const byIndex = (first: BranchOutcomeRecord, second: BranchOutcomeRecord): number =>
  first.index - second.index;

function launchRecordOf(
  ticket: LaunchTicket,
  records: readonly BranchOutcomeRecord[],
): LaunchRecord {
  return {
    launch: ticket.launchId,
    items: ticket.items,
    taken: ticket.taken,
    branches: ticket.branches.map((branch) => {
      const record = records.find((candidate) => candidate.index === branch.index);
      return {
        nodeId: branch.nodeId,
        copyNumber: branch.copyNumber,
        ...(branch.itemIndex === undefined ? {} : { itemIndex: branch.itemIndex }),
        status: record?.status ?? BranchStatus.Cancelled,
        ...(record?.error === undefined ? {} : { error: record.error }),
      };
    }),
  };
}

/** One visit of each launched node: the launch is one pass through it, however many runs. */
const visitsOf = (ticket: LaunchTicket): Record<string, number> =>
  Object.fromEntries(ticket.branches.map((branch) => [branch.node, 1]));

/** A failed launch: its `.onJoinError(…)` side path, else the branch's error. */
function failedJoin(
  launch: RuntimeLaunch,
  failed: BranchOutcomeRecord,
  thrown: unknown,
): ExecutionStateUpdate {
  const record = failed.error ?? { name: "Error", code: "Error", lineage: [], message: "failed" };
  const handler = errorHandlerOf({ errors: launch.joinErrors }, record);
  if (handler !== undefined) return { lastError: record, next: handler.to };
  // the branch's error as it was thrown; read back from its record when another process ran it
  throw thrown instanceof Error ? thrown : new RecordedBranchError(record);
}

/** The branches' values into the scope, their cascade reported under the launching step. */
async function joinedValues(
  launch: RuntimeLaunch,
  ticket: LaunchTicket,
  records: readonly BranchOutcomeRecord[],
  context: {
    readonly state: ExecutionStateType;
    readonly config?: RunnableConfig;
    readonly deps: JoinDeps;
  },
): Promise<ExecutionStateUpdate> {
  const { state, deps } = context;
  const finished = finishedOf(records);
  const site = { launch, ticket, finished, scope: state.scope, provenance: deps.provenance };
  const written = joinValuesOf(site);
  if (Object.keys(written).length === 0) return { next: launch.join.to };
  const result = writeAndOutdate(state.scope, written);
  const node = deps.graph.nodes.get(ticket.launcher);
  if (node !== undefined && result.cascades.length > 0) {
    const at = { node, visitNumber: ticket.visitNumber };
    const frame = stepFrameAt(at, state, context.config, deps.workflow);
    const outdatedSoFar = [...state.outdatedValues, ...result.outdated];
    const report = { observer: deps.observer, config: context.config, ...frame, outdatedSoFar };
    await reportOutdating(result.cascades, report);
  }
  return {
    scope: result.scope,
    outdatedValues: [...result.outdated],
    next: launch.join.to,
  };
}

/** The LangGraph node joining `launch`. */
export function joinNode(launch: RuntimeLaunch, deps: JoinDeps): GraphNode {
  return async (state, config) => {
    const ticket = state.launch;
    if (ticket?.key !== launch.key)
      throw new TypeError(`${launch.joinNodeId} ran without its launch in flight`);
    const records = state.branchRecords
      .filter((record) => record.launchId === ticket.launchId)
      .sort(byIndex);
    const live = deps.registry.find(ticket.launchId);
    deps.registry.remove(ticket.launchId);
    const done = {
      visits: visitsOf(ticket),
      launch: null,
      branchRecords: { drop: ticket.launchId },
      launches: [launchRecordOf(ticket, records)],
    };
    const failed = records.find((record) => record.status === BranchStatus.Failed);
    if (failed !== undefined)
      return { ...done, ...failedJoin(launch, failed, live?.errors.get(failed.index)) };
    const context = config === undefined ? { state, deps } : { state, config, deps };
    return { ...done, ...(await joinedValues(launch, ticket, records, context)) };
  };
}
