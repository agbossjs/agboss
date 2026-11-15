import type { RunnableConfig } from "@langchain/core/runnables";
import type { FlowEdge } from "../../analyse/flow-graph.js";
import { reportOutdating } from "../outdating-report.js";
import { writeAndOutdate } from "../outdating.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import { joinValuesOf } from "./join-values.js";
import type { JoinDeps } from "./join-node.js";
import type { BranchOutcomeRecord, LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/** Where a join reads from: the execution's state, its config and the join's deps. */
export interface JoinContext {
  readonly state: ExecutionStateType;
  readonly config?: RunnableConfig;
  readonly deps: JoinDeps;
  /** A quorum's time in the tree's queue so far (#264): its deadline moved by it, in ms. */
  readonly queuedFor?: number;
}

/** The branches' values into the scope on `edge`, their cascade reported under the launching step. */
export async function joinedValues(
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
    const frame = stepFrameAt(at, state, context.config, deps);
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
