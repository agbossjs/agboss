import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import { errorRecordOf } from "../../../core/error-record.js";
import { extractRunContext } from "../../../core/run-context.js";
import type { FlowEdge } from "../../analyse/flow-graph.js";
import { QuorumKind } from "../../ast.js";
import type { QuorumDecidedEvent } from "../../observers/quorum-decided.js";
import { nodeEventOf } from "../../observers/execution-event.js";
import { errorHandlerOf } from "../graph-model.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import type { JoinDeps } from "./join-node.js";
import { hasExpired } from "./deadline.js";
import { quorumOutcomeOf, quorumRuleOf, type QuorumOutcome } from "./quorum.js";
import { QuorumNotReachedError } from "./quorum-errors.js";
import type {
  BranchOutcomeRecord,
  LaunchRecord,
  LaunchTicket,
  QuorumGroupRecord,
} from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * The join of a quorum (#279 S26): the outcome rebuilt from the branches' records only — the counted
 * answers in counting order, the winning group — reported once (a trace entry "quorum decided" and
 * `onQuorumDecided`), then either the way on (the join's edge, or the winning group's own path) with
 * the counted answers only, or `QuorumNotReachedError` into `.onJoinError(…)`, else the execution
 * fails with it.
 */

/** Where a quorum join decides. */
export interface QuorumJoinSite {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
  /** Its launch's records, by ticket index. */
  readonly records: readonly BranchOutcomeRecord[];
  readonly state: ExecutionStateType;
  readonly config?: RunnableConfig;
  readonly deps: JoinDeps;
}

/** A reached quorum: the edge it takes and the counted answers' records, in counting order. */
export interface ReachedQuorum {
  readonly edge: FlowEdge;
  readonly counted: readonly BranchOutcomeRecord[];
}

/** What the quorum came to: reached (and how) or not, and what `result.launches` adds for it. */
export interface QuorumDecision {
  readonly reached?: ReachedQuorum;
  readonly outcome: QuorumOutcome;
  readonly extra: Pick<LaunchRecord, "isQuorumReached" | "group">;
}

const traceEntry = RunnableLambda.from((trace: object) => trace);

function groupRecordOf(
  launch: RuntimeLaunch,
  outcome: QuorumOutcome,
): QuorumGroupRecord | undefined {
  const group = outcome.group === undefined ? undefined : launch.groups[outcome.group];
  if (group === undefined) return undefined;
  const { agents, priority } = group;
  return { agents, ...(priority === undefined ? {} : { priority }) };
}

/** The quorum's outcome from its records, and the edge and answers it goes on with. */
export function decideQuorum(site: QuorumJoinSite): QuorumDecision {
  const { launch, ticket, records } = site;
  const quorum = launch.quorum;
  if (quorum === undefined) throw new TypeError(`${launch.joinNodeId}: no quorum`);
  const nodes = ticket.branches.map((branch) => branch.node);
  const outcome = quorumOutcomeOf(quorumRuleOf(quorum, launch.groups), records, nodes);
  const group = groupRecordOf(launch, outcome);
  const extra = { isQuorumReached: outcome.isReached, ...(group === undefined ? {} : { group }) };
  if (!outcome.isReached) return { outcome, extra };
  const edge = outcome.group === undefined ? launch.join : launch.groups[outcome.group]?.edge;
  const counted = outcome.counted.flatMap(
    (answer) => records.find((record) => record.index === answer.index) ?? [],
  );
  return { outcome, extra, ...(edge === undefined ? {} : { reached: { edge, counted } }) };
}

/** The trace entry and the `onQuorumDecided` event of a decided quorum. */
export async function reportQuorum(
  site: QuorumJoinSite,
  decision: QuorumDecision,
  record: LaunchRecord,
): Promise<void> {
  const { ticket, state, config, deps } = site;
  const counted = decision.outcome.counted.map((answer) => ticket.branches[answer.index]?.nodeId);
  const parent = config ?? {};
  const options = { callbacks: parent.callbacks, tags: parent.tags, metadata: parent.metadata };
  const trace = { launch: ticket.launchId, isReached: decision.extra.isQuorumReached, counted };
  await traceEntry.invoke(trace, { ...options, runName: "quorum decided" });
  const node = deps.graph.nodes.get(ticket.launcher);
  if (node === undefined || deps.observer === undefined) return;
  const at = { node, visitNumber: ticket.visitNumber };
  const frame = stepFrameAt(at, state, config, deps.workflow, deps.contexts);
  const event: QuorumDecidedEvent = {
    ...nodeEventOf(frame),
    launch: ticket.launchId,
    isReached: decision.extra.isQuorumReached ?? false,
    branches: record.branches,
    ...(decision.extra.group === undefined ? {} : { group: decision.extra.group }),
  };
  await deps.observer.onQuorumDecided(event);
}

/** Why the quorum was not reached: its deadline, or nothing left that could reach it. */
function reasonOf(site: QuorumJoinSite): string {
  const { deadlineAt } = site.ticket;
  const { clock } = extractRunContext(site.config, site.state.runId);
  if (deadlineAt !== undefined && hasExpired(clock, deadlineAt)) return "the deadline passed";
  return site.launch.quorum?.kind === QuorumKind.Groups
    ? "no group can complete any more"
    : "min can no longer be reached";
}

/** A quorum not reached: `.onJoinError(QuorumNotReachedError, …)`, else the execution fails. */
export function quorumNotReached(
  site: QuorumJoinSite,
  decision: QuorumDecision,
): ExecutionStateUpdate {
  const { ticket, launch } = site;
  const step = {
    component: { name: ticket.launcher },
    nodeId: ticket.launcher,
    visitNumber: ticket.visitNumber,
  };
  const min = launch.quorum?.kind === QuorumKind.Count ? launch.quorum.min : undefined;
  const shortfall = {
    ...(min === undefined ? {} : { min }),
    counted: decision.outcome.counted.length,
    reason: reasonOf(site),
  };
  const error = new QuorumNotReachedError(ticket.launchId, step, shortfall);
  const record = errorRecordOf(error);
  const handler = errorHandlerOf({ errors: launch.joinErrors }, record);
  if (handler === undefined) throw error;
  return { lastError: record, next: handler.to };
}
