import type { StepSlots } from "../app/step-slots.js";
import { StepEntries, type StepEntry } from "../flow/runtime/step-entries.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { Milliseconds } from "../units/index.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * What an application instance shares between its workflows and what its graceful stop does with
 * the running step bodies (#367): the registry, the stop's end, the warning for a body still running.
 */

/**
 * The instance's step slots (#332), one for all its workflows — loaded only when the application
 * caps them (QUALITY.md → Design: the root import keeps only the option's type).
 */
async function stepSlotsOf(
  assembled: AssembledApplication,
  clock: Clock,
): Promise<StepSlots | undefined> {
  const cap = assembled.maxConcurrentSteps;
  if (cap === undefined) return undefined;
  const { StepSlots: Slots } = await import("../app/step-slots.js");
  return new Slots(cap, clock);
}

/** What the instance shares between its workflows: its step slots (#332) and running steps (#367). */
export interface SharedInstanceParts {
  readonly stepSlots: StepSlots | undefined;
  readonly stepEntries: StepEntries;
  /** What its graceful stop does with them. */
  readonly stepsAtStop: StepsAtStop;
}

/**
 * The instance's step slots and its running step bodies (its stop awaits them before onDestroy) —
 * loaded with the instance (`await import`), not with the root import.
 */
export async function instancePartsOf(
  assembled: AssembledApplication,
  clock: Clock,
  log: FrameworkLog,
): Promise<SharedInstanceParts> {
  const stepEntries = new StepEntries();
  const stepsAtStop = stepsAtStopOf(stepEntries, stopDeadlineOf(clock), log);
  return { stepSlots: await stepSlotsOf(assembled, clock), stepEntries, stepsAtStop };
}

/** The running step bodies at the instance's graceful stop: its end, and the wait for them. */
export interface StepsAtStop extends StopDeadline {
  /**
   * Until every running body of the instance returned or the stop's end — then one
   * `app.step-still-running` warning per body still running.
   */
  settled(): Promise<void>;
}

function stepsAtStopOf(
  entries: StepEntries,
  deadline: StopDeadline,
  log: FrameworkLog,
): StepsAtStop {
  return {
    ...deadline,
    settled: async () => {
      warnStillRunning(log, await entries.allClosed(deadline.signal));
    },
  };
}

/**
 * The end of an instance's graceful stop (#367): each `close({ timeout })` sets an end — its call
 * on the `Clock` plus its timeout (`@Application({ shutdownTimeout })` when it gives none) — and
 * the stop's end is the latest of them. Until then the step bodies a rejected pass left running
 * are awaited before `onDestroy` and before their tree's lease is released; at it the stop goes on.
 */
export interface StopDeadline {
  /** Aborted at the stop's end. */
  readonly signal: AbortSignal;
  /** A `close` with `timeout`: the end moves to now + `timeout` when that is later. */
  extendTo(timeout: Milliseconds): void;
  /** The stop has finished: its timer is cleared. */
  release(): void;
}

function stopDeadlineOf(clock: Clock): StopDeadline {
  const ended = new AbortController();
  let endsAt = Number.NEGATIVE_INFINITY;
  let timer: AbortController | undefined;
  return {
    signal: ended.signal,
    extendTo: (timeout) => {
      const at = clock.now().getTime() + timeout;
      if (ended.signal.aborted || at <= endsAt) return;
      endsAt = at;
      timer?.abort();
      if (timeout <= 0) {
        ended.abort();
        return;
      }
      const own = new AbortController();
      timer = own;
      void clock.sleep(timeout, own.signal).then(() => {
        if (!own.signal.aborted) ended.abort();
      });
    },
    release: () => {
      timer?.abort();
    },
  };
}

/** The step a still-running body belongs to, for the log: ids only, never a value. */
const stepOf = (entry: StepEntry): string =>
  [
    `step ${entry.nodeId} (visit ${String(entry.visitNumber)}`,
    entry.itemIndex === undefined ? "" : `, item ${String(entry.itemIndex)}`,
    entry.callId === undefined ? "" : `, tool call ${entry.callId}`,
    `) of execution ${entry.executionId}`,
  ].join("");

/** One `app.step-still-running` warning per body still running at the end of the stop. */
function warnStillRunning(log: FrameworkLog, still: readonly StepEntry[]): void {
  for (const entry of still) {
    log.warn(
      "app.step-still-running",
      `${stepOf(entry)} is still running at the end of the shutdown timeout: the app stops without waiting for it`,
      { executionId: entry.executionId, tenantId: entry.tenantId },
    );
  }
}
