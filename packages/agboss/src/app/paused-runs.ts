import { ExecutionStatus } from "./types.js";
import type { ResumeVersions } from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import { PauseResolution, PauseStatus } from "../infrastructure/paused-execution.repository.js";
import { cancelledPause, logPauseAnswer } from "../infrastructure/pause-record.js";
import type { PauseSeam } from "../pause/index.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ThreadKey } from "./live-runs.js";

/**
 * A paused run and the workflow version / config hash it paused under (checked on resume). Its
 * pauses — each with its id, status and decision — are records of their own (#267 S35).
 */
export interface PausedRun extends ResumeVersions {
  readonly run: AgentExecutionOutput;
}

/** The app's view of its paused runs: settle each run, drop a cancelled one, find one. */
export interface PausedRunBook {
  /** Remembers a paused run with the app's versions, forgets a thread whose run ended. */
  readonly settle: (run: AgentExecutionOutput) => Promise<void>;
  /**
   * Forgets the thread's paused run and cancels its pending pauses (a cancel) and returns it;
   * `undefined` when none waits — a later resume of one of its pauses gets `NotPausedError`.
   */
  readonly drop: (thread: ThreadKey) => Promise<AgentExecutionOutput | undefined>;
  /** The thread's paused run as stored now (`undefined` when none). */
  readonly find: (thread: ThreadKey) => Promise<PausedRun | undefined>;
}

/** The pause records and the log of how each was resolved (#267 S107). */
export type PauseStores = Pick<PauseSeam, "pauses" | "answers">;

export function pausedRunBook(
  stores: PauseStores,
  current: ResumeVersions,
  clock: Clock,
): PausedRunBook {
  const repository = stores.pauses;
  const find = ({ tenantId, threadId }: ThreadKey): Promise<PausedRun | undefined> =>
    repository.findByTenantIdAndThreadId(tenantId, threadId);
  return {
    settle: (run) =>
      run.status === ExecutionStatus.Paused
        ? repository.save({ run, ...current })
        : repository.deleteByTenantIdAndThreadId(run.tenantId, run.threadId),
    drop: async (thread) => {
      const stored = await find(thread);
      if (stored === undefined) return undefined;
      const tree = { tenantId: thread.tenantId, rootExecutionId: stored.run.runId };
      await withdrawPauses(stores, tree, clock.now());
      await repository.deleteByTenantIdAndThreadId(thread.tenantId, thread.threadId);
      return stored.run;
    },
    find,
  };
}

/**
 * The pauses of a tree that ended (finished, failed, cancelled): the waiting ones are cancelled —
 * `Cancelled` (`PauseResolution.Cancelled`, `at`), so a late answer gets `NotPausedError`, like an
 * answer to one already taken.
 */
export async function withdrawPauses(
  stores: PauseStores,
  tree: ExecutionTree,
  at: Date,
): Promise<void> {
  const { tenantId, rootExecutionId } = tree;
  const { pauses, answers } = stores;
  const records = await pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  const cancelled = PauseResolution.Cancelled;
  for (const pause of records) {
    if (
      pause.status === PauseStatus.Pending &&
      (await pauses.cancelByTenantIdAndPauseId(tenantId, pause.pauseId, cancelled, at))
    )
      await logPauseAnswer(answers, cancelledPause(pause, cancelled, at), cancelled);
  }
}
