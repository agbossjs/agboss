import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { seconds, type Milliseconds } from "../units/index.js";

/**
 * The pause timers of an application instance (#940, #941+): one loop that every few seconds runs
 * each look — the delivery of pause notices now, the expiry and the reminders later — each in its
 * own `try/catch`: a look that fails is logged (`pause-timers.failed`, its name) and the other
 * looks and the next tick go on. The loop records when its last tick ended, and
 * `app.checkLiveness()` reports it stale beside the recovery sweep.
 */

/** How often the loop ticks. */
export const PAUSE_TIMERS_EVERY: Milliseconds = seconds(5);

/** One look of the loop. */
export interface TimerLook {
  /** What the log names when it fails. */
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** The loop of one instance. */
export interface PauseTimers {
  /** Stops ticking; resolves when the tick in flight ended. */
  stop(): Promise<void>;
  /** When its last tick ended — its start before the first. */
  lastTickAt(): Date;
  /** Whether `stop()` was called. */
  isStopped(): boolean;
}

/** What the loop is made of. */
export interface PauseTimerSources {
  readonly clock: Clock;
  readonly log: FrameworkLog;
  readonly looks: readonly TimerLook[];
  /** Aborted by the instance's stop. */
  readonly signal: AbortSignal;
}

class Loop implements PauseTimers {
  readonly #stopped = new AbortController();
  readonly #loop: Promise<void>;
  #lastTickAt: Date;

  constructor(private readonly sources: PauseTimerSources) {
    this.#lastTickAt = sources.clock.now();
    this.#loop = this.#run();
  }

  lastTickAt(): Date {
    return this.#lastTickAt;
  }

  isStopped(): boolean {
    return this.#stopped.signal.aborted;
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    const { clock, signal } = this.sources;
    const stopping = AbortSignal.any([this.#stopped.signal, signal]);
    while (!stopping.aborted) {
      for (const look of this.sources.looks) await this.#safely(look);
      this.#lastTickAt = clock.now();
      await clock.sleep(PAUSE_TIMERS_EVERY, stopping);
    }
  }

  /** One look, its failure logged: never the other looks', never the loop's. */
  async #safely(look: TimerLook): Promise<void> {
    try {
      await look.run();
    } catch (error) {
      const text = `the pause timers' ${look.name} look failed: ${String(error)}`;
      this.sources.log.error("pause-timers.failed", text);
    }
  }
}

/** Starts the loop: a tick now, then every `PAUSE_TIMERS_EVERY`. */
export const startPauseTimers = (sources: PauseTimerSources): PauseTimers => new Loop(sources);
