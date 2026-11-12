import { ExecutionStatus } from "./types.js";
import type { ResumeVersions } from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseCancellation,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import { withdrawPause, type PauseStores } from "../flow/runtime/launch/withdrawn-pauses.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ThreadKey } from "./live-runs.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { runningOutcome } from "../run/execute.js";
import { NotPausedError } from "../run/resume-agent.js";
import type { TurnStore } from "../turns/index.js";

/**
 * A paused run and the workflow version / config hash it paused under (checked on resume). Its
 * pauses — each with its id, status and decision — are records of their own (#267 S35).
 */
export interface PausedExecution extends ResumeVersions {
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
  readonly drop: (thread: ThreadKey, runId?: string) => Promise<AgentExecutionOutput | undefined>;
  /** The thread's paused run as stored now (`undefined` when none). */
  readonly find: (thread: ThreadKey) => Promise<PausedExecution | undefined>;
}

export function pausedRunBook(
  stores: PauseStores,
  current: ResumeVersions,
  clock: Clock,
): PausedRunBook {
  const repository = stores.pauses;
  const find = ({ tenantId, threadId }: ThreadKey): Promise<PausedExecution | undefined> =>
    repository.findByTenantIdAndThreadId(tenantId, threadId);
  return {
    settle: (run) =>
      run.status === ExecutionStatus.Paused
        ? repository.save({ run, ...current })
        : repository.deleteByTenantIdAndThreadId(run.tenantId, run.threadId),
    drop: async (thread, runId) => {
      const stored = await find(thread);
      // #807: the run the caller holds the lease of, never one its thread paused since
      if (stored === undefined || (runId !== undefined && stored.run.runId !== runId))
        return undefined;
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
 * answer to one already taken; the channel of a sent one is told (#337). An answered one no step
 * took (`Resolved`: a resume recorded it, a cancel won before its pass ran, #811 s18c) is marked
 * `Taken`, its answer kept and no channel told, so `deleteByResolvedAtBefore` removes it after
 * `retention.pauseRecords` (#890 AC5).
 */
export async function withdrawPauses(
  stores: PauseStores,
  tree: ExecutionTree,
  at: Date,
): Promise<void> {
  const { tenantId, rootExecutionId } = tree;
  const records = await stores.pauses.findAllByTenantIdAndRootExecutionId(
    tenantId,
    rootExecutionId,
  );
  const resolution: PauseCancellation = PauseResolution.Cancelled;
  const closing = { resolution, at };
  for (const pause of records) {
    if (pause.status === PauseStatus.Pending) await withdrawPause(stores, pause, closing);
    else if (pause.status === PauseStatus.Resolved)
      await stores.pauses.markTakenByTenantIdAndPauseId(tenantId, pause.pauseId);
  }
}

/**
 * A resting tree has work again before its answer is recorded (#850): its root's record goes
 * `paused → running` first, then the pause `Pending → Resolved`. A resume that dies between the two
 * leaves a `running` root, which recovery continues with the recorded answer (its resolved pauses
 * first, under the lease, once) — never a `paused` root with a `Resolved` pause nothing moves. One
 * that dies before the answer, or is refused after the mark, leaves a `running` root at its pause:
 * recovery rests it there again.
 */

/** What marking a resting root needs from its workflow's app. */
export interface AnsweredRootParts {
  readonly pauses: PausedExecutionRepository;
  readonly paused: PausedRunBook;
  /** The roots' records: a resting one is `running` again before its answer is recorded. */
  readonly turns: Pick<TurnStore, "completeIfStatus">;
  /** Where a resume refused after its mark is told (a warning: recovery rests the tree again). */
  readonly log: Pick<FrameworkLog, "warn">;
}

export const notPaused = (pauseId: string): NotPausedError =>
  new NotPausedError({ message: `pause ${pauseId} is not waiting for an answer` });

/**
 * The root of a pause about to be answered, `running` again: the pause read once more (a resume
 * answered meanwhile — after a reply's interpreter, say — is refused here, before any mark), the
 * run as it rests now. `true` when this call made it `running`; `false` with no resting run (its
 * first pass still moves it) or a record no longer `paused` (another resume's mark, or its end).
 */
export async function markAnswered(
  parts: AnsweredRootParts,
  pause: PauseRecord,
  rested: AgentExecutionOutput | undefined,
): Promise<boolean> {
  const now = await parts.pauses.findByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
  if (now?.status !== PauseStatus.Pending) throw notPaused(pause.pauseId);
  if (rested === undefined) return false;
  const stored = await parts.paused.find({ tenantId: pause.tenantId, threadId: pause.threadId });
  const run = stored?.run.runId === rested.runId ? stored.run : rested;
  const outcome = runningOutcome(run.path, run.cost.totalUsd);
  return parts.turns.completeIfStatus(run.turnId, ExecutionRecordStatus.Paused, outcome);
}

/** A resume refused after its mark: told, since its root stays `running` until recovery rests it. */
export function refusedAfterMark(parts: AnsweredRootParts, pause: PauseRecord): NotPausedError {
  const subject = { executionId: pause.rootExecutionId, tenantId: pause.tenantId };
  const text = `the resume of pause ${pause.pauseId} was refused after it made execution ${pause.rootExecutionId} running again: recovery rests it at its pause`;
  parts.log.warn("resume.refused-after-mark", text, subject);
  return notPaused(pause.pauseId);
}
