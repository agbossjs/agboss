import { ExecutionStatus } from "./types.js";
import type { ResumeVersions } from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../infrastructure/paused-execution.repository.js";
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

export function pausedRunBook(
  repository: PausedExecutionRepository,
  current: ResumeVersions,
  clock: Clock,
): PausedRunBook {
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
      await withdrawPauses(repository, tree, clock.now());
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
  repository: PausedExecutionRepository,
  tree: ExecutionTree,
  at: Date,
): Promise<void> {
  const { tenantId, rootExecutionId } = tree;
  const pauses = await repository.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  for (const { pauseId, status } of pauses) {
    if (status === PauseStatus.Pending)
      await repository.cancelByTenantIdAndPauseId(tenantId, pauseId, PauseResolution.Cancelled, at);
  }
}
