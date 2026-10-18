import type { RunnableConfig } from "@langchain/core/runnables";
import { isGraphInterrupt } from "@langchain/langgraph";
import { handedOverReason } from "../../../app/handed-over.js";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import { WorkflowCancelledError } from "../../../core/errors.js";
import { extractRunContext } from "../../../core/run-context.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { StepFailedError } from "../../../graph/errors.js";
import { runInFrame } from "../../context/frame.js";
import { FailurePolicy } from "../../decorators/router.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { checkVisit, isWorkingNode } from "../limits.js";
import type { GraphNode, NodeOutcome, NodeRunner } from "../node-runner.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { startedVersionOf, stepFrameAt } from "../step-frame.js";
import { daySpentBeforeRun, unrecordedSpendOf, type VisitDeps } from "../visit.js";
import {
  branchConfigOf,
  branchLaunchOf,
  branchStateOf,
  branchTicketOf,
  type BranchLaunch,
} from "./branch-view.js";
import type { LaunchRegistry, LiveLaunch } from "./launch-registry.js";
import { reportBranch } from "./launch-report.js";
import { BranchStatus, type BranchOutcomeRecord, type BranchTicket } from "./records.js";

/**
 * One branch of a launch (#273 S20, S21): one `Send` task. It takes a slot of the launch's
 * semaphore when it starts and frees it in `finally` — when it ends, fails, is cancelled or pauses —
 * checks the limits for its own visit, runs its node in its own frame (copy id, copy number, item),
 * and writes how it ended as a record: `Finished` with its value, `Skipped` for a step failure under
 * `FailurePolicy.Skip`, `Failed` (which aborts the launch, so its siblings end `Cancelled`) for
 * anything else — a limit too. A pause, a hand-over and a cancel of the execution pass through
 * LangGraph; everything else meets at the join.
 */

export interface BranchDeps extends VisitDeps {
  readonly graph: RuntimeGraph;
  readonly registry: LaunchRegistry;
}

/** One branch's run: where it stands, and what it gave or spent so far. */
interface BranchRun {
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly config: RunnableConfig | undefined;
  readonly ticket: BranchTicket;
  readonly owner: BranchLaunch;
  readonly live: LiveLaunch;
  readonly deps: BranchDeps;
  /** What its code paid services (`SpendRecorder`). */
  readonly services: UsageRecord[];
  /** Whether it passed its limits and ran as a step (agents only). */
  ranAsStep: boolean;
}

/** How a branch ended: its record and the keys it writes. */
interface BranchEnd {
  readonly status: BranchStatus;
  readonly update: ExecutionStateUpdate;
  readonly value?: NodeOutcome["value"];
  readonly read: readonly string[];
  readonly error?: ErrorRecord;
}

/** A run's bookkeeping: its path entry and step; the node's visit is counted once, by the join. */
const visited = (run: BranchRun): ExecutionStateUpdate => ({
  path: [run.ticket.nodeId],
  steps: run.ranAsStep ? 1 : 0,
});

async function ran(run: BranchRun, runner: NodeRunner, daySpent: number): Promise<BranchEnd> {
  const { node, ticket, deps, live } = run;
  const view = branchStateOf(run.state, run.owner.launch, ticket, live.spent);
  if (isWorkingNode(node)) {
    checkVisit(view, node, deps.limits, daySpent);
    run.ranAsStep = true;
  }
  const { run: execution } = extractRunContext(run.config, run.state.runId);
  const signal = AbortSignal.any([execution.signal, live.controller.signal]);
  const config = branchConfigOf(run.config, signal, run.state.runId);
  const { visitNumber, nodeId, copyNumber, itemIndex } = ticket;
  const site = {
    node,
    visitNumber,
    nodeId,
    copyNumber,
    ...(itemIndex === undefined ? {} : { itemIndex }),
  };
  const reportUsage = (record: UsageRecord): void => {
    run.services.push({ ...record, caller: `${node.kind}:${node.id}` });
  };
  const frame = { ...stepFrameAt(site, view, config, deps.workflow), services: { reportUsage } };
  const outcome = await runInFrame(frame, () => runner(view, config));
  const usage = [...(outcome.usage ?? []), ...run.services];
  live.spent.push(...usage);
  return {
    status: BranchStatus.Finished,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    read: outcome.read,
    update: {
      ...visited(run),
      usage,
      approvals: [...(outcome.approvals ?? [])],
    },
  };
}

/** A branch that threw: skipped, failed (aborting its siblings) or cancelled by a sibling. */
function ended(run: BranchRun, error: unknown): BranchEnd {
  if (isGraphInterrupt(error)) throw error;
  passThroughStops(run);
  const { live, ticket } = run;
  const usage = [...unrecordedSpendOf(error), ...run.services];
  live.spent.push(...usage);
  const isSkipped = ticket.failure === FailurePolicy.Skip && error instanceof StepFailedError;
  const status = live.controller.signal.aborted
    ? BranchStatus.Cancelled
    : isSkipped
      ? BranchStatus.Skipped
      : BranchStatus.Failed;
  if (status === BranchStatus.Failed) {
    live.errors.set(ticket.index, error);
    live.controller.abort();
  }
  const update = { ...visited(run), usage };
  return { status, read: [], error: errorRecordOf(error), update };
}

/** The execution's own signal (`app.cancel`, the caller's signal, a hand-over), not the launch's. */
const executionSignalOf = (run: BranchRun): AbortSignal =>
  extractRunContext(run.config, run.state.runId).run.signal;

/**
 * A hand-over and a cancel of the execution are no outcome of the branch (S21): they stop the whole
 * execution — never recorded, never `Skip`ped, never taken by `.onJoinError(…)`.
 */
function passThroughStops(run: BranchRun): void {
  const handedOver = handedOverReason(run.config?.signal);
  if (handedOver !== undefined) throw handedOver;
  if (executionSignalOf(run).aborted || run.config?.signal?.aborted === true)
    throw new WorkflowCancelledError("the execution was cancelled during a parallel launch");
}

async function runBranch(run: BranchRun, runner: NodeRunner): Promise<BranchEnd> {
  const { live } = run;
  const stop = AbortSignal.any([executionSignalOf(run), live.controller.signal]);
  const isTaken = await live.slots.acquire(stop);
  if (!isTaken) {
    passThroughStops(run);
    return { status: BranchStatus.Cancelled, read: [], update: {} };
  }
  let daySpent: number | null = run.state.daySpentBeforeRunUsd;
  try {
    if (isWorkingNode(run.node)) daySpent = await daySpentBeforeRun(run.state, run.deps);
    const end = await ran(run, runner, daySpent ?? 0);
    return { ...end, update: { ...end.update, daySpentBeforeRunUsd: daySpent } };
  } catch (error) {
    const end = ended(run, error);
    return { ...end, update: { ...end.update, daySpentBeforeRunUsd: daySpent } };
  } finally {
    live.slots.release();
  }
}

const recordOf = (launchId: string, index: number, end: BranchEnd): BranchOutcomeRecord => ({
  launchId,
  index,
  status: end.status,
  ...(end.value === undefined ? {} : { value: end.value }),
  read: end.read,
  ...(end.error === undefined ? {} : { error: end.error }),
});

/** The LangGraph node of a branch node: it runs only as a launch's `Send`. */
export function branchNode(node: RuntimeNode, runner: NodeRunner, deps: BranchDeps): GraphNode {
  return async (state, config) => {
    const ticket = branchTicketOf(state);
    const owner = branchLaunchOf(state, deps.graph.launches);
    const { launchId, maxConcurrency, branches } = owner.ticket;
    const live = deps.registry.liveOf(launchId, maxConcurrency ?? Math.max(branches.length, 1));
    const run: BranchRun = {
      ...{ node, state, config, ticket, owner, live, deps },
      services: [],
      ranAsStep: false,
    };
    const end = await runBranch(run, runner);
    await reportBranch(config, launchId, ticket, end);
    return {
      ...end.update,
      branchRecords: { add: [recordOf(launchId, ticket.index, end)] },
      next: owner.launch.joinNodeId,
      startedVersion: startedVersionOf(state, deps.workflow),
    };
  };
}
