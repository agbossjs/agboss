import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { Class } from "../../../components/injection.js";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import { extractRunContext } from "../../../core/run-context.js";
import { totalCost, type UsageRecord } from "../../../finops/usage.js";
import type { ArbiterClass } from "../../ast.js";
import { runInFrame } from "../../context/frame.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { checkVisit, isWorkingNode } from "../limits.js";
import type { GraphNode, NodeOutcome, NodeRunner } from "../node-runner.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { startedVersionOf, stepFrameAt } from "../step-frame.js";
import { unrecordedSpendOf, type VisitDeps } from "../visit.js";
import type { ArbiterModel } from "./arbiter-model.js";
import type { ArbiterDeps } from "./arbiters.js";
import { executionSignalOf, failedStatusOf, passThroughStops } from "./branch-end.js";
import {
  branchConfigOf,
  branchLaunchOf,
  branchStateOf,
  branchTicketOf,
  type BranchLaunch,
} from "./branch-view.js";
import type { LaunchRegistry, LiveLaunch } from "./launch-registry.js";
import { reportBranch } from "./launch-report.js";
import { pendingRecordsOf } from "./pending-records.js";
import { leaveQuorum, markAnswer, quorumMakerOf, type QuorumMark } from "./quorum-branch.js";
import { BranchStatus, type BranchOutcomeRecord, type BranchTicket } from "./records.js";

/**
 * One branch of a launch (#273 S20, S21): one `Send` task. It takes a slot of the launch's
 * semaphore when it starts and frees it in `finally` — when it ends, fails, is cancelled or pauses —
 * checks the limits for its own visit, runs its node in its own frame (copy id, copy number, item),
 * and writes how it ended as a record: `Finished` with its value, `Skipped` for a step failure under
 * `FailurePolicy.Skip`, `Failed` (which aborts the launch, so its siblings end `Cancelled`) for
 * anything else — a limit too. Under a quorum (#279) its arbiter chain runs in the same slot and
 * frame, and the record carries the answer's verdict. A pause, a hand-over and a cancel of the
 * execution pass through LangGraph; everything else meets at the join.
 */

/** What arbiters run on (#279): their instances from the container, their models. */
export interface BranchArbiters {
  readonly instanceOf: (arbiter: Class) => unknown;
  readonly modelOf?: (arbiter: ArbiterClass) => ArbiterModel | undefined;
}

export interface BranchDeps extends VisitDeps {
  readonly graph: RuntimeGraph;
  readonly registry: LaunchRegistry;
  readonly arbiters?: BranchArbiters;
  /** Where a quorum's finished branches are read back from after a resume or a crash. */
  readonly checkpointer?: BaseCheckpointSaver;
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
  readonly mark?: QuorumMark;
}

/** A run's bookkeeping: its path entry and step; the node's visit is counted once, by the join. */
const visited = (run: BranchRun): ExecutionStateUpdate => ({
  path: [run.ticket.nodeId],
  steps: run.ranAsStep ? 1 : 0,
});

/** The arbiters of the branch's quorum, the budgets checked before each model call. */
function arbiterDepsOf(run: BranchRun, view: ExecutionStateType): ArbiterDeps {
  const { budgets } = run.deps.limits;
  const parts = run.deps.arbiters;
  return {
    instanceOf: parts?.instanceOf ?? ((): undefined => undefined),
    ...(parts?.modelOf === undefined ? {} : { modelOf: parts.modelOf }),
    beforeModelCall: async (spent) => {
      await budgets.refresh();
      const path = [...view.path, run.ticket.nodeId];
      budgets.check(totalCost([...view.usage, ...run.services, ...spent]), path);
    },
  };
}

async function ran(run: BranchRun, runner: NodeRunner): Promise<BranchEnd> {
  const { node, ticket, deps, live } = run;
  const view = branchStateOf(run.state, run.owner.launch, ticket, live.spent);
  if (isWorkingNode(node)) {
    // the view's spend: the execution's at the launch plus the siblings that already ended (#273 S71)
    await checkVisit(view, node, deps.limits, deps.workflow);
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
  const frame = {
    ...stepFrameAt(site, view, config, deps.workflow, deps.contexts),
    services: { reportUsage },
  };
  const arbiters = { launch: run.owner.launch, deps: arbiterDepsOf(run, view) };
  const { outcome, marked } = await runInFrame(frame, async () => {
    const answered = await runner(view, config);
    return { outcome: answered, marked: await markAnswer(live, ticket, answered.value, arbiters) };
  });
  const usage = [...(outcome.usage ?? []), ...(marked?.usage ?? []), ...run.services];
  live.spent.push(...usage);
  return {
    status: BranchStatus.Finished,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(marked === undefined ? {} : { mark: marked.mark }),
    read: outcome.read,
    update: { ...visited(run), usage, approvals: [...(outcome.approvals ?? [])] },
  };
}

/** A branch that threw: skipped, failed (aborting its siblings) or cancelled by a sibling. */
function ended(run: BranchRun, error: unknown): BranchEnd {
  if (isGraphInterrupt(error)) throw error;
  passThroughStops(run.config, run.state.runId);
  const { live, ticket } = run;
  const usage = [...unrecordedSpendOf(error), ...run.services];
  live.spent.push(...usage);
  const isQuorum = live.quorum !== undefined;
  const status = failedStatusOf({ live, ticket, isQuorum }, error);
  if (status === BranchStatus.Failed) {
    live.errors.set(ticket.index, error);
    live.controller.abort();
  }
  leaveQuorum(live, ticket);
  const update = { ...visited(run), usage };
  return { status, read: [], error: errorRecordOf(error), update };
}

async function runBranch(run: BranchRun, runner: NodeRunner): Promise<BranchEnd> {
  const { live } = run;
  await live.quorum?.ready;
  const stop = AbortSignal.any([
    executionSignalOf(run.config, run.state.runId),
    live.controller.signal,
  ]);
  const isTaken = await live.slots.acquire(stop);
  if (!isTaken) {
    passThroughStops(run.config, run.state.runId);
    leaveQuorum(live, run.ticket);
    return { status: BranchStatus.Cancelled, read: [], update: {} };
  }
  try {
    return await ran(run, runner);
  } catch (error) {
    return ended(run, error);
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
  ...end.mark,
});

/** The launch's entry in this process; a quorum's rebuilt from the checkpoint (#279 S26). */
function liveLaunchOf(
  owner: BranchLaunch,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  deps: BranchDeps,
): LiveLaunch {
  const { launchId, maxConcurrency, branches } = owner.ticket;
  const { clock } = extractRunContext(config, state.runId);
  const pending = () => pendingRecordsOf(deps.checkpointer, config, launchId);
  const makeQuorum = quorumMakerOf({ launch: owner.launch, ticket: owner.ticket, clock, pending });
  const size = maxConcurrency ?? Math.max(branches.length, 1);
  return deps.registry.liveOf(launchId, size, makeQuorum);
}

/** The LangGraph node of a branch node: it runs only as a launch's `Send`. */
export function branchNode(node: RuntimeNode, runner: NodeRunner, deps: BranchDeps): GraphNode {
  return async (state, config) => {
    const ticket = branchTicketOf(state);
    const owner = branchLaunchOf(state, deps.graph.launches);
    const live = liveLaunchOf(owner, state, config, deps);
    const run: BranchRun = {
      ...{ node, state, config, ticket, owner, live, deps },
      services: [],
      ranAsStep: false,
    };
    const end = await runBranch(run, runner);
    await reportBranch(config, owner.ticket.launchId, ticket, end);
    return {
      ...end.update,
      branchRecords: { add: [recordOf(owner.ticket.launchId, ticket.index, end)] },
      next: owner.launch.joinNodeId,
      startedVersion: startedVersionOf(state, deps.workflow),
    };
  };
}
