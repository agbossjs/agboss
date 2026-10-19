import type { RunnableConfig } from "@langchain/core/runnables";
import type { ErrorRecord } from "../../../core/error-record.js";
import type { FlowEdge } from "../../analyse/flow-graph.js";
import { errorHandlerOf, type RuntimeGraph } from "../graph-model.js";
import type { GraphNode } from "../node-runner.js";
import { reportOutdating } from "../outdating-report.js";
import { writeAndOutdate } from "../outdating.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import type { VisitDeps } from "../visit.js";
import { finishedOf, joinValuesOf } from "./join-values.js";
import type { BranchErrors, LaunchRegistry } from "./launch-registry.js";
import {
  BranchStatus,
  type BranchOutcomeRecord,
  type LaunchRecord,
  type LaunchTicket,
} from "./records.js";
import { decideQuorum, quorumNotReached, reportQuorum } from "./quorum-join.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * The join of a launch (#273 S20): a LangGraph node of its own, run once after every branch ended.
 * It reads only its own launch's records (a launch inside a loop never sees an earlier pass's),
 * drops them, records the launch for `result.launches`, and goes on — on the main path with the
 * branches' values written into the scope at once (one outdating cascade), or, when a branch
 * failed, into the most specific `.onJoinError(E, …)` by the error's class and cause chain. No
 * handler: the execution fails with the branch's error as it was thrown. A quorum join (#279)
 * decides from the records (`quorum-join.ts`) and writes only the counted answers.
 */

export interface JoinDeps extends VisitDeps {
  readonly graph: RuntimeGraph;
  readonly registry: LaunchRegistry;
  /** A failed branch's error from an earlier pass of this process (#267 AC10). */
  readonly branchErrors?: BranchErrors;
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

/** What a quorum made of a branch's answer (#279), as `result.launches` shows it. */
const verdictOf = ({ verdict, acceptedSequence, rejectedBy }: BranchOutcomeRecord) => ({
  ...(verdict === undefined ? {} : { verdict }),
  ...(acceptedSequence === undefined ? {} : { acceptedSequence }),
  ...(rejectedBy === undefined ? {} : { rejectedBy }),
});

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
        ...(record === undefined ? {} : verdictOf(record)),
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

/** Where a join reads from: the execution's state, its config and the join's deps. */
interface JoinContext {
  readonly state: ExecutionStateType;
  readonly config?: RunnableConfig;
  readonly deps: JoinDeps;
}

/** The branches' values into the scope on `edge`, their cascade reported under the launching step. */
async function joinedValues(
  launch: RuntimeLaunch,
  edge: FlowEdge,
  ticket: LaunchTicket,
  finished: readonly BranchOutcomeRecord[],
  context: JoinContext,
): Promise<ExecutionStateUpdate> {
  const { state, deps } = context;
  const site = { launch, edge, ticket, finished, scope: state.scope, provenance: deps.provenance };
  const written = joinValuesOf(site);
  if (Object.keys(written).length === 0) return { next: edge.to };
  const result = writeAndOutdate(state.scope, written);
  const node = deps.graph.nodes.get(ticket.launcher);
  if (node !== undefined && result.cascades.length > 0) {
    const at = { node, visitNumber: ticket.visitNumber };
    const frame = stepFrameAt(at, state, context.config, deps.workflow, deps.contexts);
    const outdatedSoFar = [...state.outdatedValues, ...result.outdated];
    const report = { observer: deps.observer, config: context.config, ...frame, outdatedSoFar };
    await reportOutdating(result.cascades, report);
  }
  return {
    scope: result.scope,
    outdatedValues: [...result.outdated],
    next: edge.to,
  };
}

/** A quorum join: decided from the records, reported, then on with the counted answers or failed. */
async function quorumJoined(
  launch: RuntimeLaunch,
  ticket: LaunchTicket,
  records: readonly BranchOutcomeRecord[],
  context: JoinContext,
): Promise<ExecutionStateUpdate> {
  const site = { launch, ticket, records, ...context };
  const decision = decideQuorum(site);
  const launches = [{ ...launchRecordOf(ticket, records), ...decision.extra }];
  const [record] = launches;
  if (record !== undefined) await reportQuorum(site, decision, record);
  if (decision.reached === undefined) return { launches, ...quorumNotReached(site, decision) };
  const { edge, counted } = decision.reached;
  return { launches, ...(await joinedValues(launch, edge, ticket, counted, context)) };
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
    const thrownOf = (index: number): unknown =>
      live?.errors.get(index) ?? deps.branchErrors?.find(ticket.launchId, index);
    const done = {
      visits: visitsOf(ticket),
      launch: null,
      branchRecords: { drop: ticket.launchId },
      launches: [launchRecordOf(ticket, records)],
    };
    const failed = records.find((record) => record.status === BranchStatus.Failed);
    const thrown = failed === undefined ? undefined : thrownOf(failed.index);
    deps.branchErrors?.forgetLaunch(ticket.launchId);
    if (failed !== undefined) return { ...done, ...failedJoin(launch, failed, thrown) };
    const context = config === undefined ? { state, deps } : { state, config, deps };
    if (launch.quorum !== undefined)
      return { ...done, ...(await quorumJoined(launch, ticket, records, context)) };
    const finished = finishedOf(records);
    return { ...done, ...(await joinedValues(launch, launch.join, ticket, finished, context)) };
  };
}
