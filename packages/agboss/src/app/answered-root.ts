import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import { runningOutcome } from "../run/execute.js";
import { NotPausedError } from "../run/resume-agent.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { TernStore } from "../terns/index.js";
import type { PausedRunBook } from "./paused-runs.js";

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
  readonly terns: Pick<TernStore, "completeIfStatus">;
  /** Where a resume refused after its mark is told (a warning: recovery rests the tree again). */
  readonly log: Pick<FrameworkLog, "warn">;
}

export const notPaused = (pauseId: string): NotPausedError =>
  new NotPausedError(`pause ${pauseId} is not waiting for an answer`);

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
  return parts.terns.completeIfStatus(run.ternId, ExecutionRecordStatus.Paused, outcome);
}

/** A resume refused after its mark: told, since its root stays `running` until recovery rests it. */
export function refusedAfterMark(parts: AnsweredRootParts, pause: PauseRecord): NotPausedError {
  const subject = { executionId: pause.rootExecutionId, tenantId: pause.tenantId };
  const text = `the resume of pause ${pause.pauseId} was refused after it made execution ${pause.rootExecutionId} running again: recovery rests it at its pause`;
  parts.log.warn("resume.refused-after-mark", text, subject);
  return notPaused(pause.pauseId);
}
