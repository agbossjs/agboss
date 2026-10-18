import { ExecutionStatus } from "./types.js";
import { NotPausedError } from "../run/resume-agent.js";
import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";

/** A paused run and the workflow version / config hash it paused under (checked on resume). */
export interface PausedRun extends ResumeVersions {
  readonly run: AgentExecutionOutput;
}

/** The app's view of its paused runs: settle each run, hand out a run that may be resumed. */
export interface PausedRunBook {
  /** Remembers a paused run with the app's versions, forgets a thread whose run ended. */
  readonly settle: (run: AgentExecutionOutput) => Promise<void>;
  /** Forgets the thread's paused run (a cancel) and returns it; `undefined` when none waits. */
  readonly drop: (thread: string) => Promise<AgentExecutionOutput | undefined>;
  /** The run paused on `thread`; `NotPausedError` / `IncompatibleResumeError` when it cannot resume. */
  readonly resumable: (thread: string) => Promise<AgentExecutionOutput>;
}

export function pausedRunBook(
  repository: PausedExecutionRepository,
  current: ResumeVersions,
  policy: IncompatibleResumePolicy | undefined,
): PausedRunBook {
  return {
    settle: (run) =>
      run.status === ExecutionStatus.Paused
        ? repository.save({ run, ...current })
        : repository.deleteByThreadId(run.threadId),
    drop: async (thread) => {
      const stored = await repository.findByThreadId(thread);
      if (stored !== undefined) await repository.deleteByThreadId(thread);
      return stored?.run;
    },
    resumable: async (thread) => {
      const stored = await repository.findByThreadId(thread);
      if (stored === undefined) throw new NotPausedError(`Thread "${thread}" has no paused run`);
      const { run, workflowVersion, configHash } = stored;
      const paused = { workflowVersion, configHash };
      checkResume({ thread, runId: run.runId, paused, current }, policy);
      return run;
    },
  };
}
