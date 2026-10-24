import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ExecutionRecordStatus } from "../../../infrastructure/execution-record.repository.js";
import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../../infrastructure/clock.js";
import { treeKeyOf } from "../../../infrastructure/in-memory-database.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import type { ExecutionGraph } from "../build.js";
import { asRootRun, isExecutionState, rootConfigOf } from "../child-thread.js";
import type { ExecutionStateType } from "../state.js";
import { encodedRun, type RemoteChildRun } from "./remote-child-run.js";
import { remoteChildSignals } from "./remote-child-signals.js";
import { remoteFailureOf } from "./remote-failure.js";

/**
 * A child on any instance, as its parent's step sees it (#333 PR 2, S6): the parent's node queues
 * the child (`ChildExecutionQueueRepository`, once — a re-entry finds its row) and waits inside its
 * step until the row ends — woken at once when the child ends in this process, else it reads the
 * row again every second on the `Clock`. Its step's signal ends the wait (a `FailFast` sibling, a
 * cancel, a lost lease); the parent's tree keeps its lease meanwhile (yielding it is #333 PR 4).
 * The child's state is read from its own thread, as for a local child; its failure comes back as
 * its error's name, code and message.
 */

/** What a parent's node queues and waits with: the instance's queue and clock. */
export interface RemoteChildren {
  readonly queue: ChildExecutionQueueRepository;
  readonly clock: Clock;
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

const isEnded = (row: QueuedChildExecution | undefined): row is QueuedChildExecution =>
  row?.status === ExecutionRecordStatus.Answered || row?.status === ExecutionRecordStatus.Failed;

class RemoteChildLostError extends Error {
  override name = "RemoteChildLostError";
}

/** The child's row: queued now unless it is there (a re-entry after a pause or a crash). */
async function queuedRow(site: RemoteChildSite): Promise<QueuedChildExecution | undefined> {
  const { queue, clock } = site.children;
  const found = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
  if (found !== undefined) return found;
  await queue.saveIfAbsent({
    tenantId: site.tenantId,
    executionId: site.executionId,
    rootExecutionId: site.rootExecutionId,
    parentExecutionId: site.parentExecutionId,
    rootWorkflow: site.rootWorkflow,
    workflow: site.workflow,
    depth: site.depth,
    status: ExecutionRecordStatus.Queued,
    run: await encodedRun(site.checkpointer.serde, site.run),
    queuedAt: clock.now(),
  });
  remoteChildSignals.queued();
  return queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
}

/** Until the child's row ends; the step's signal stops the wait with its reason. */
async function endedRow(site: RemoteChildSite): Promise<QueuedChildExecution> {
  const { queue, clock } = site.children;
  const key = treeKeyOf(site.tenantId, site.executionId);
  let row = await queuedRow(site);
  for (;;) {
    site.signal.throwIfAborted();
    if (row === undefined)
      throw new RemoteChildLostError(`child execution ${site.executionId} is no longer queued`);
    if (isEnded(row)) return row;
    const watch = remoteChildSignals.watchEnd(key);
    try {
      row = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
      if (isEnded(row)) return row;
      await clock.sleep(RECHECK_EVERY, AbortSignal.any([watch.signal, site.signal]));
      row = await queue.findByTenantIdAndExecutionId(site.tenantId, site.executionId);
    } finally {
      watch.close();
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

/** The child queued for any instance and awaited: its end as its parent continues it. */
export async function remoteChildEndOf(
  graph: ExecutionGraph,
  config: RunnableConfig,
  site: RemoteChildSite,
): Promise<RemoteChildEnd> {
  const row = await endedRow(site);
  const state = await lastStateOf(graph, config, site.run.thread);
  if (row.status === ExecutionRecordStatus.Answered)
    return state === undefined ? { failed: false } : { state, failed: false };
  const error = remoteFailureOf(row.failure);
  return state === undefined ? { error, failed: true } : { error, state, failed: true };
}
