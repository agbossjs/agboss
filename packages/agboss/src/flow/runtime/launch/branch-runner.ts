import type { RunnableConfig } from "@langchain/core/runnables";
import { isGraphInterrupt } from "@langchain/langgraph";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { runInFrame } from "../../context/frame.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { checkVisit, isWorkingNode } from "../limits.js";
import { recordsOf, type GraphNode, type NodeOutcome, type NodeRunner } from "../node-runner.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { startedVersionOf } from "../step-frame.js";
import { unrecordedSpendOf, type VisitDeps } from "../visit.js";
import {
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
import { withdrawSiblingPauses } from "./withdrawn-pauses.js";
import { gated, inSchedule, type ScheduledBranch } from "./branch-schedule.js";
import { inTreeSlot } from "../step-frame.js";
import { branchFrameOf } from "./branch-view.js";
import type { PausedExecutionRepository } from "../../../infrastructure/paused-execution.repository.js";
import type { ChildExecutionRecord } from "../child-records.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";

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
  /** The application's pauses: a `FailFast` failure withdraws its paused siblings' (#267 AC10). */
  readonly pauses?: PausedExecutionRepository;
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
  readonly children: ChildExecutionRecord[];
  /** A failed per-item child's PII tokens (#120): kept with its error. */
  piiTokens: PiiTokenMap;
  /** The branch as a test's scheduler sees it (#262 S33). */
  readonly scheduled: ScheduledBranch;
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

/** A run's bookkeeping: its path entry, step and children; the node's visit is counted by the join. */
const visited = (run: BranchRun): ExecutionStateUpdate => ({
  path: [run.ticket.nodeId],
  steps: run.ranAsStep ? 1 : 0,
  children: [...run.children],
  piiTokens: run.piiTokens,
});

/** How a branch whose node answered ended: finished with its verdict, or cancelled by its quorum. */
function answeredEnd(
  run: BranchRun,
  outcome: NodeOutcome,
  marked: MarkedAnswer | undefined,
): BranchEnd {
  const usage = [...(outcome.usage ?? []), ...(marked?.usage ?? []), ...run.services];
  run.live.spent.push(...usage);
  const update = { ...visited(run), ...recordsOf(outcome), usage };
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
  const { config, frame, signal } = branchFrameOf(run, view);
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
        await checkVisit(view, node, deps.limits, deps.workflow);
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
  return answeredEnd(run, outcome, marked);
}

/** A failed branch aborts its launch: its siblings stop, their pending pauses are withdrawn. */
async function abortLaunch(run: BranchRun): Promise<void> {
  const { live, deps, state, owner, ticket } = run;
  live.controller.abort();
  if (deps.pauses === undefined) return;
  const tenantId = state.contexts.tenant.tenantId;
  const at = extractRunContext(run.config, state.runId).clock.now();
  const site = { tenantId, rootExecutionId: state.runId, launch: owner.ticket, failed: ticket, at };
  await withdrawSiblingPauses(deps.pauses, site);
}

/** A branch that threw: skipped, failed (aborting its siblings) or cancelled by a sibling. */
async function ended(run: BranchRun, error: unknown): Promise<BranchEnd> {
  if (isGraphInterrupt(error)) throw error;
  passThroughStops(run.config, run.state.runId);
  const { live, ticket } = run;
  const usage = [...unrecordedSpendOf(error), ...run.services];
  live.spent.push(...usage);
  const isQuorum = live.quorum !== undefined;
  const status = failedStatusOf({ live, ticket, isQuorum }, error);
  if (status === BranchStatus.Failed) {
    live.errors.set(ticket.index, error);
    run.deps.branchErrors?.keep(run.owner.ticket.launchId, ticket.index, error);
    await abortLaunch(run);
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
      ranAsStep: false,
    };
    const end = await inSchedule(deps.scheduler, scheduled, () => runBranch(run, runner));
    await reportBranch(config, owner.ticket.launchId, ticket, end);
    return {
      ...end.update,
      branchRecords: { add: [branchRecordOf(owner.ticket.launchId, ticket.index, end)] },
      next: owner.launch.joinNodeId,
      startedVersion: startedVersionOf(state, deps.workflow),
    };
  };
}
