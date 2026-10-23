import type { RunnableConfig } from "@langchain/core/runnables";
import { isGraphInterrupt } from "@langchain/langgraph";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { runInFrame } from "../../context/frame.js";
import { failedVisitOf, visitStepsOf, visitTimerOf, type VisitSite } from "../visit-step.js";
import { compensationsOfBranch } from "../../compensation.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { checkVisit, isWorkingNode } from "../limits.js";
import { recordsOf, type GraphNode, type NodeOutcome, type NodeRunner } from "../node-runner.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { inTreeSlot, startedVersionOf } from "../step-frame.js";
import type { VisitDeps } from "../visit.js";
import { unrecordedSpendOf } from "../node-runner.js";
import {
  failureOfBranch,
  branchRecordOf,
  executionSignalOf,
  failedStatusOf,
  passThroughStops,
  type BranchErrors,
} from "./branch-end.js";
import {
  branchLaunchOf,
  branchStateOf,
  branchTicketOf,
  scheduledOf,
  type BranchLaunch,
} from "./branch-view.js";
import type { LiveLaunch } from "./launch-registry.js";
import { reportBranch } from "./launch-report.js";
import { arbiterDepsFor, liveLaunchOf, type BranchQuorumDeps } from "./branch-quorum.js";
import { leaveQuorum, markAnswer, type MarkedAnswer, type QuorumMark } from "./quorum-branch.js";
import { BranchStatus, type BranchTicket } from "./records.js";
import { launchPausesOf, withdrawLaunchPauses } from "./withdrawn-pauses.js";
import { gated, inSchedule, type ScheduledBranch } from "./branch-schedule.js";
import { branchFrameOf, branchVisitOf } from "./branch-view.js";
import type { EndedChildRecord } from "../child-records.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";
import type { CompensationEntry } from "../../compensation.js";

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

export interface BranchDeps extends VisitDeps, BranchQuorumDeps {
  readonly graph: RuntimeGraph;
  /** Where a failed branch's error waits for a join in a later pass of this process. */
  readonly branchErrors?: BranchErrors;
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
  /** The child executions it ran that ended (a per-item child workflow, #263). */
  readonly children: EndedChildRecord[];
  /** A failed per-item child's PII tokens (#120): kept with its error. */
  piiTokens: PiiTokenMap;
  /** A failed per-item child's undone entries (#340). */
  readonly compensations: CompensationEntry[];
  /** The branch as a test's scheduler sees it (#262 S33). */
  readonly scheduled: ScheduledBranch;
  /** Whether it passed its limits and ran as a step (agents only). */
  ranAsStep: boolean;
  /** The pass's budgets' `exhausted` signal it watches (#338), once its frame is made. */
  budgetStop?: AbortSignal;
  /** Where its visit ran, once its frame is made: a failure records its step there (#395 S6). */
  visited?: () => VisitSite;
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

/** How a branch whose node answered ended: finished with its verdict, or cancelled by its quorum. */
function answeredEnd(
  run: BranchRun,
  outcome: NodeOutcome,
  marked: MarkedAnswer | undefined,
  compensations: ExecutionStateUpdate,
  site: VisitSite,
): BranchEnd {
  const arbiters = marked?.usage ?? [];
  const usage = [...(outcome.usage ?? []), ...arbiters, ...run.services];
  // its arbiters' decisions counted as they end (#338); its node counted its own calls
  run.deps.limits.budgets.tally(arbiters);
  run.live.spent.push(...usage);
  const stepRecords = visitStepsOf(site, { outcome, usage }); // #395 C3
  const visited = { ...branchVisitOf(run), ...recordsOf(outcome) };
  const update = { ...visited, usage, ...compensations, stepRecords };
  // a quorum decided while its arbiters checked the answer: cancelled, its spend kept (#279 AC12)
  if (marked !== undefined && marked.mark === undefined)
    return { status: BranchStatus.Cancelled, read: outcome.read, update };
  return {
    status: BranchStatus.Finished,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(marked?.mark === undefined ? {} : { mark: marked.mark }),
    read: outcome.read,
    update,
  };
}

async function ran(run: BranchRun, runner: NodeRunner): Promise<BranchEnd> {
  const { node, ticket, deps, live } = run;
  const { nodeId } = ticket;
  const view = branchStateOf(run.state, run.owner.launch, ticket, live.spent);
  const { config, frame, signal, budgetStop } = branchFrameOf(run, view);
  run.visited = visitTimerOf(config, run.state.runId, { frame, node, state: view });
  run.budgetStop = budgetStop;
  const arbiterDeps = arbiterDepsFor({ ...deps, live, view, services: run.services, nodeId });
  const arbiters = { launch: run.owner.launch, deps: arbiterDeps };
  const gate = { scheduler: deps.scheduler, branch: run.scheduled, signal };
  // a slot of the tree (#264) after the launch's; a quorum's deadline excludes the wait (#279)
  const slot = { slots: deps.slots, graph: deps.graph, node, state: view, config, ...frame };
  const { outcome, marked } = await inTreeSlot(
    { ...slot, watch: live.quorum?.queued },
    async () => {
      if (isWorkingNode(node)) {
        // the view's spend: the execution's at the launch plus the siblings that ended (#273 S71)
        await checkVisit(view, node, deps.limits, deps.workflow, frame.step.component);
        run.ranAsStep = true;
      }
      return runInFrame(frame, async () => {
        // a test's completion gate (#262 S33): none in production
        const answered = await gated(gate, () => runner(view, config));
        return {
          outcome: answered,
          marked: await markAnswer(live, ticket, answered.value, arbiters),
        };
      });
    },
  );
  // an undoable action's branch opens its entry as it ends (#340): a failed join undoes it
  const branch = { launchId: run.owner.ticket.launchId, value: outcome.value };
  const opened = await compensationsOfBranch({ node, view, frame, config, branch, deps });
  return answeredEnd(run, outcome, marked, opened, run.visited());
}

/**
 * Withdraws the pending pauses under `branches` of the run's launch (#267 AC10, #337): its own when
 * it ended `Cancelled` (asked after the abort), its siblings' when it failed.
 */
const withdrawUnder = (run: BranchRun, branches: readonly BranchTicket[]): Promise<void> =>
  withdrawLaunchPauses(launchPausesOf(run.deps.pauses, run.state, run.config), branches);

/** A failed branch aborts its launch: its siblings stop, their pending pauses are withdrawn. */
async function abortLaunch(run: BranchRun): Promise<void> {
  const { live, owner, ticket } = run;
  live.controller.abort();
  await withdrawUnder(
    run,
    owner.ticket.branches.filter((branch) => branch.index !== ticket.index),
  );
}

/** A branch that threw: skipped, failed (aborting its siblings) or cancelled by a sibling. */
async function ended(run: BranchRun, error: unknown): Promise<BranchEnd> {
  if (isGraphInterrupt(error)) throw error;
  passThroughStops(run.config, run.state.runId);
  const { live, ticket } = run;
  // the spend the error carries is the original one's (an aborted loop's calls so far)
  const usage = [...unrecordedSpendOf(error), ...run.services];
  live.spent.push(...usage);
  const failure = failureOfBranch(run.budgetStop, error);
  const status = failedStatusOf({ live, ticket, isQuorum: live.quorum !== undefined }, failure);
  if (status === BranchStatus.Failed) {
    live.errors.set(ticket.index, failure);
    run.deps.branchErrors?.keep(run.owner.ticket.launchId, ticket.index, failure);
    await abortLaunch(run);
  }
  leaveQuorum(live, ticket);
  const update = { ...branchVisitOf(run), usage, ...failedVisitOf(run.visited?.(), error, usage) };
  return { status, read: [], error: errorRecordOf(failure), update };
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
  run.deps.scheduler?.started(run.scheduled);
  try {
    return await ran(run, runner);
  } catch (error) {
    return await ended(run, error);
  } finally {
    live.slots.release();
  }
}

/** The LangGraph node of a branch node: it runs only as a launch's `Send`. */
export function branchNode(node: RuntimeNode, runner: NodeRunner, deps: BranchDeps): GraphNode {
  return async (state, config) => {
    const ticket = branchTicketOf(state);
    const owner = branchLaunchOf(state, deps.graph.launches);
    const live = liveLaunchOf(owner, state, config, deps);
    const scheduled = scheduledOf({ node, state, ticket, owner, live, graph: deps.graph });
    const run: BranchRun = {
      ...{ node, state, config, ticket, owner, live, deps, scheduled },
      services: [],
      children: [],
      piiTokens: {},
      compensations: [],
      ranAsStep: false,
    };
    const branch = (): Promise<BranchEnd> =>
      inSchedule(deps.scheduler, scheduled, () => runBranch(run, runner));
    // a decided quorum's withdrawal (#337): closed before the branch ends, so the drain takes it
    const end = await (live.quorum?.withdrawal.during(branch) ?? branch());
    if (end.status === BranchStatus.Cancelled) await withdrawUnder(run, [ticket]);
    await reportBranch(config, owner.ticket.launchId, ticket, end);
    return {
      ...end.update,
      branchRecords: { add: [branchRecordOf(owner.ticket.launchId, ticket.index, end)] },
      next: owner.launch.joinNodeId,
      startedVersion: startedVersionOf(state, deps.workflow),
    };
  };
}
