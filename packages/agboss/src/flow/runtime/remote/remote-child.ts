import { interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ExecutionRecordStatus } from "../../../infrastructure/execution-record.repository.js";
import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../../infrastructure/clock.js";
import type { RateLimitRepository } from "../../../infrastructure/rate-limit.repository.js";
import { treeKeyOf } from "../../../infrastructure/in-memory-database.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import type { ExecutionGraph } from "../build.js";
import { resumeMapOf, type ChildWaiting } from "../child-own-thread.js";
import { asRootRun, isExecutionState, rootConfigOf } from "../child-thread.js";
import type { ExecutionStateType } from "../state.js";
import { encodedRun, type RemoteChildRun } from "./remote-child-run.js";
import { remoteChildSignals } from "./remote-child-signals.js";
import { remoteFailureOf } from "./remote-failure.js";

/**
 * A child on any instance, as its parent's step sees it (#333 PR 2, PR 4, S6, S9): the parent's
 * node queues the child (`ChildExecutionQueueRepository`, once — a re-entry finds its row) and
 * waits inside its step until the row settles, temporarily yielding the root's lease in
 * `ExecutionLeaseRepository` while waiting and re-acquiring it before continuing. When the child
 * rests at a pause (`ExecutionRecordStatus.Paused`), the parent's node interrupts with
 * `{ waitingForChild: { …, remote: true } }`, and on `app.resume` forwards the child's resume map
 * through the queue so any instance continues the child on `<parentThreadId>/child/<id>`.
 */

/**
 * What a parent's node queues and waits with: the instance's queue and clock, where the slots of a
 * tree that can launch on any instance are kept (#333 PR 3), and how the pass yields its lease (#333 PR 4).
 */
export interface RemoteChildren {
  readonly queue: ChildExecutionQueueRepository;
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
  /** Yields the holder's lease in `ExecutionLeaseRepository` while waiting for remote children (#333 PR 4). */
  readonly yieldWhile?: (<T>(wait: () => Promise<T>) => Promise<T>) | undefined;
}

/** How often a waiting parent reads its child's row (another process gives no hint). */
const RECHECK_EVERY: Milliseconds = seconds(1);

/** One child the parent's node launches on any instance. */
export interface RemoteChildSite {
  readonly children: RemoteChildren;
  readonly checkpointer: BaseCheckpointSaver;
  readonly tenantId: string;
  readonly executionId: string;
  readonly rootExecutionId: string;
  readonly parentExecutionId: string;
  /** The application's workflow whose tree it is (the root's). */
  readonly rootWorkflow: string;
  /** The child workflow's name. */
  readonly workflow: string;
  readonly depth: number;
  /** The parent's node of the child: its compiled graph is registered on it. */
  readonly node: string;
  readonly isRecursive: boolean;
  readonly run: RemoteChildRun;
  /** The parent's step's signal: ends the wait. */
  readonly signal: AbortSignal;
}

/** How a remote child ended, as the parent's step continues it. */
export interface RemoteChildEnd {
  readonly state?: ExecutionStateType;
  readonly error?: unknown;
  readonly failed: boolean;
}

const isSettled = (row: QueuedChildExecution): boolean =>
  row.status === ExecutionRecordStatus.Answered ||
  row.status === ExecutionRecordStatus.Failed ||
  row.status === ExecutionRecordStatus.Paused;

class RemoteChildLostError extends Error {
  override name = "RemoteChildLostError";
}

/** A queue row for `site` with `run`. */
async function rowOf(site: RemoteChildSite, run: RemoteChildRun): Promise<QueuedChildExecution> {
  return {
    tenantId: site.tenantId,
    executionId: site.executionId,
    rootExecutionId: site.rootExecutionId,
    parentExecutionId: site.parentExecutionId,
    rootWorkflow: site.rootWorkflow,
    workflow: site.workflow,
    depth: site.depth,
    status: ExecutionRecordStatus.Queued,
    run: await encodedRun(site.checkpointer.serde, run),
    queuedAt: site.children.clock.now(),
  };
}

/** The child's row: queued now unless it is there (a re-entry after a pause or a crash). */
async function queuedRow(site: RemoteChildSite): Promise<QueuedChildExecution | undefined> {
  const { queue } = site.children;
  const found = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
  if (found !== undefined) return found;
  await queue.saveIfAbsent(await rowOf(site, site.run));
  remoteChildSignals.queued();
  return queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
}

/** Until the child's row settles; a `Running` row whose worker lost its lease is reclaimed (#333 PR 4). */
async function endedRow(
  site: RemoteChildSite,
  initial: QueuedChildExecution | undefined,
): Promise<QueuedChildExecution> {
  const { queue, clock } = site.children;
  const key = treeKeyOf(site.tenantId, site.executionId);
  let row = initial;
  for (;;) {
    site.signal.throwIfAborted();
    if (row === undefined)
      throw new RemoteChildLostError(`child execution ${site.executionId} is no longer queued`);
    if (isSettled(row)) return row;
    if (row.status === ExecutionRecordStatus.Running) remoteChildSignals.running(row);
    const watch = remoteChildSignals.watchEnd(key);
    try {
      row = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
      if (row !== undefined && isSettled(row)) return row;
      if (row?.status === ExecutionRecordStatus.Running) remoteChildSignals.running(row);
      await clock.sleep(RECHECK_EVERY, AbortSignal.any([watch.signal, site.signal]));
      row = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
    } finally {
      watch.close();
    }
  }
}

/** Queues the child if absent and awaits its pass while yielding the parent's lease (#333 PR 4). */
async function waitedRow(site: RemoteChildSite): Promise<QueuedChildExecution> {
  const initial = await queuedRow(site);
  if (initial !== undefined && isSettled(initial)) return initial;
  const wait = (): Promise<QueuedChildExecution> => endedRow(site, initial);
  return site.children.yieldWhile === undefined ? wait() : site.children.yieldWhile(wait);
}

const waitingOf = (site: RemoteChildSite): ChildWaiting => ({
  waitingForChild: {
    executionId: site.executionId,
    thread: site.run.thread,
    node: site.node,
    isRecursive: site.isRecursive,
    remote: true,
  },
});

/** Whether `thread` currently waits at an interrupt that `resume` answers. */
async function hasOpenInterrupt(
  graph: ExecutionGraph,
  config: RunnableConfig,
  thread: string,
  resume: Readonly<Record<string, string>>,
): Promise<boolean> {
  const snapshot = await asRootRun(() => graph.getState(rootConfigOf(config, thread)));
  return snapshot.tasks.some((task) =>
    task.interrupts.some((each) => each.id !== undefined && each.id in resume),
  );
}

/** Continues the child across passes: interrupts on `Paused`, re-queues with `resume` on `app.resume`. */
async function settledRow(
  graph: ExecutionGraph,
  config: RunnableConfig,
  site: RemoteChildSite,
): Promise<QueuedChildExecution> {
  for (;;) {
    const row = await waitedRow(site);
    if (row.status !== ExecutionRecordStatus.Paused) return row;
    const answer: unknown = interrupt(waitingOf(site));
    const resume = resumeMapOf(answer);
    if (await hasOpenInterrupt(graph, config, site.run.thread, resume)) {
      if (await site.children.queue.saveIfAbsent(await rowOf(site, { ...site.run, resume })))
        remoteChildSignals.queued();
    }
  }
}

/** The child's last state on its own thread. */
async function lastStateOf(
  graph: ExecutionGraph,
  config: RunnableConfig,
  thread: string,
): Promise<ExecutionStateType | undefined> {
  const snapshot = await asRootRun(() => graph.getState(rootConfigOf(config, thread)));
  return isExecutionState(snapshot.values) ? snapshot.values : undefined;
}

/**
 * The child's state with its own calls marked as in the ledger (#333 PR 3): the worker recorded
 * them as they were made, so its parent's pass counts them and never writes them again.
 */
const recordedElsewhere = (
  state: ExecutionStateType,
  inheritedUsage: number,
): ExecutionStateType => ({
  ...state,
  usage: state.usage.map((record, index) =>
    index < inheritedUsage ? record : { ...record, isRecordedElsewhere: true },
  ),
});

/** The child queued for any instance and awaited: its end as its parent continues it. */
export async function remoteChildEndOf(
  graph: ExecutionGraph,
  config: RunnableConfig,
  site: RemoteChildSite,
): Promise<RemoteChildEnd> {
  const row = await settledRow(graph, config, site);
  const last = await lastStateOf(graph, config, site.run.thread);
  const inherited = site.run.initial.child.inheritedUsage;
  const state = last === undefined ? undefined : recordedElsewhere(last, inherited);
  if (row.status === ExecutionRecordStatus.Answered)
    return state === undefined ? { failed: false } : { state, failed: false };
  const error = remoteFailureOf(row.failure);
  return state === undefined ? { error, failed: true } : { error, state, failed: true };
}
