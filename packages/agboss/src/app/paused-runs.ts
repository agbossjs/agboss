import { isDeadlineDue } from "../infrastructure/instants.js";
import { z } from "zod";
import { ExecutionStatus } from "./types.js";
import type { ResumeVersions } from "../run/resume-guard.js";
import type { AgentExecutionOutput } from "../run/types.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import { pauseKeyOf } from "../infrastructure/pause-record.js";
import { PauseError } from "../core/error-families/pause-errors.js";
import { pauseClosed } from "./pause-closed.js";
import { ExecutionCancelledError } from "../core/errors.js";
import { closeTreePauses } from "./tree-end-pauses.js";
import type { PauseStores } from "../flow/runtime/launch/withdrawn-pauses.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ThreadKey } from "./live-runs.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { runningOutcome } from "../run/execute.js";
import type { TurnStore } from "../turns/index.js";
import { pausedRunOfValue } from "../infrastructure/stored-run.js";
import { parsedStoredJson } from "../infrastructure/stored-step.js";

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
  readonly drop: (
    thread: ThreadKey,
    runId?: string,
    cause?: Error,
  ) => Promise<AgentExecutionOutput | undefined>;
  /** The thread's paused run as stored now (`undefined` when none). */
  readonly find: (thread: ThreadKey) => Promise<PausedExecution | undefined>;
}

export function pausedRunBook(
  stores: PauseStores,
  current: ResumeVersions,
  clock: Clock,
): PausedRunBook {
  const ends = { stores };
  const repository = stores.pauses;
  const find = ({ tenantId, threadId }: ThreadKey): Promise<PausedExecution | undefined> =>
    repository.findByTenantIdAndThreadId(tenantId, threadId);
  return {
    settle: (run) =>
      run.status === ExecutionStatus.Paused
        ? repository.save({ run, ...current })
        : repository.deleteByTenantIdAndThreadId(run.tenantId, run.threadId),
    drop: async (thread, runId, why) => {
      const stored = await find(thread);
      // #807: the run the caller holds the lease of, never one its thread paused since
      if (stored === undefined || (runId !== undefined && stored.run.runId !== runId))
        return undefined;
      const site = { ...thread, rootExecutionId: stored.run.runId };
      // a cancel (`app.cancel` of a resting or a running tree): its paused run first, by run (#939)
      const cause = why ?? new ExecutionCancelledError({ message: "the tree was cancelled" });
      await closeTreePauses(ends, site, { cause }, clock.now());
      return stored.run;
    },
    find,
  };
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
  /** The application's clock: the refusal's reading of a deadline. */
  readonly clock: Pick<Clock, "now">;
}

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
  // a deadline passed meanwhile (a reply's interpreter takes time): refused before the mark (#941)
  const isDue = isDeadlineDue(now?.expiresAt, parts.clock.now());
  if (now?.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
  if (rested === undefined) return false;
  const stored = await parts.paused.find({ tenantId: pause.tenantId, threadId: pause.threadId });
  const run = stored?.run.runId === rested.runId ? stored.run : rested;
  const outcome = runningOutcome(run.path, run.cost.totalUsd);
  return parts.turns.completeIfStatus(run.turnId, ExecutionRecordStatus.Paused, outcome);
}

/** A resume refused after its mark: told, since its root stays `running` until recovery rests it. */
export async function refusedAfterMark(
  parts: AnsweredRootParts,
  pause: PauseRecord,
): Promise<Error> {
  const subject = { executionId: pause.rootExecutionId, tenantId: pause.tenantId };
  const text = `the resume of pause ${pauseKeyOf(pause.tenantId, pause.pauseId)} was refused after it made execution ${pause.rootExecutionId} running again: recovery rests it at its pause`;
  parts.log.warn("resume.refused-after-mark", text, subject);
  return pauseClosed(parts.pauses, pause, parts.clock.now());
}

/**
 * Why the store did not record an answer: the pause closed or its deadline passed (`Closed`; after a
 * mark, told), or it is still open but no longer the pause the answer was permitted over — changed in
 * place meanwhile — and `PauseError.UpdateContended` says so: nothing was written, the retry asks the
 * permit again over what the pause is now.
 */
export async function refusedAnswer(
  parts: AnsweredRootParts,
  pause: PauseRecord,
  isMarked: boolean,
): Promise<Error> {
  const closed = await (isMarked
    ? refusedAfterMark(parts, pause)
    : pauseClosed(parts.pauses, pause, parts.clock.now()));
  const fresh = await parts.pauses.findByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
  const isOpen =
    fresh?.status === PauseStatus.Pending && !isDeadlineDue(fresh.expiresAt, parts.clock.now());
  return isOpen
    ? new PauseError.UpdateContended({
        message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: it changed while the answer was permitted; retry is safe and asks the permit again`,
      })
    : closed;
}

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

/** A paused run as text, its non-finite numbers tagged. */
export const encodePausedRun = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

/**
 * The run `encodePausedRun` wrote, or why it is refused.
 * `ids` are the store's own keys of the row: text that is not JSON names no id of its own. A text that
 * is no JSON is `StoreError.UnreadableRecord` (#1121), as a value that fails the schema is.
 */
export function decodePausedRun(
  text: string,
  ids: { readonly threadId?: string; readonly runId?: string } = {},
): AgentExecutionOutput {
  return pausedRunOfValue(
    parsedStoredJson({
      what: "paused run",
      text,
      ids,
      reviver: (_key, item: unknown) => {
        const tagged = NonFinite.safeParse(item);
        return tagged.success ? Number(tagged.data.$number) : item;
      },
    }),
  );
}
