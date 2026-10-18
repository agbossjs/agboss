import { ExecutionStatus } from "./types.js";
import { NotPausedError } from "../run/resume-agent.js";
import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
} from "../infrastructure/paused-execution.repository.js";

/**
 * A paused run, the workflow version / config hash it paused under (checked on resume), and where
 * its pause is: `Pending`, or `Resolved` with the decision a resume recorded (#265, Q58).
 */
export interface PausedRun extends ResumeVersions {
  readonly run: AgentExecutionOutput;
  /** `Pending` until a resume records its decision, then `Resolved`. */
  readonly status: PauseStatus;
  /** The decision, once `Resolved`. */
  readonly decision?: unknown;
}

/** The app's view of its paused runs: settle each run, hand out a run that may be resumed. */
export interface PausedRunBook {
  /** Remembers a paused run (`Pending`) with the app's versions, forgets a thread whose run ended. */
  readonly settle: (run: AgentExecutionOutput) => Promise<void>;
  /** Forgets the thread's paused run (a cancel) and returns it; `undefined` when none waits. */
  readonly drop: (thread: string) => Promise<AgentExecutionOutput | undefined>;
  /**
   * Records the decision of the thread's pending run (`Pending` → `Resolved`, atomic) and returns
   * the run; `NotPausedError` when none is pending (also: a second resume of the same pause),
   * `IncompatibleResumeError` when this app may not resume it (it stays pending).
   */
  readonly resolve: (thread: string, decision: unknown) => Promise<AgentExecutionOutput>;
  /** The thread's paused run as stored now (`undefined` when none). */
  readonly find: (thread: string) => Promise<PausedRun | undefined>;
}

export function pausedRunBook(
  repository: PausedExecutionRepository,
  current: ResumeVersions,
  policy: IncompatibleResumePolicy | undefined,
): PausedRunBook {
  const notPaused = (thread: string): NotPausedError =>
    new NotPausedError(`Thread "${thread}" has no paused run`);
  return {
    settle: (run) =>
      run.status === ExecutionStatus.Paused
        ? repository.save({ run, ...current, status: PauseStatus.Pending })
        : repository.deleteByThreadId(run.threadId),
    drop: async (thread) => {
      const stored = await repository.findByThreadId(thread);
      if (stored !== undefined) await repository.deleteByThreadId(thread);
      return stored?.run;
    },
    resolve: async (thread, decision) => {
      const stored = await repository.findByThreadId(thread);
      if (stored?.status !== PauseStatus.Pending) throw notPaused(thread);
      const { run, workflowVersion, configHash } = stored;
      const paused = { workflowVersion, configHash };
      checkResume({ thread, runId: run.runId, paused, current }, policy);
      const resolved = await repository.resolveByThreadId(thread, decision);
      if (resolved === undefined) throw notPaused(thread);
      return resolved.run;
    },
    find: (thread) => repository.findByThreadId(thread),
  };
}
