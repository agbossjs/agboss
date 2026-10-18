import { isHandedOver } from "../app/handed-over.js";
import type { RecoverRoot } from "../app/recover-root.js";
import { IncompatibleResumeError } from "../run/resume-guard.js";
import type { Tern } from "../terns/index.js";
import { seconds, type Milliseconds } from "../units/index.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { Clock } from "./clock.js";

/**
 * Automatic recovery (#265 S30): every application instance looks for the roots left `running` —
 * at its start and then every lease length — and continues each whose lease it can take (its
 * holder died, or stopped and released it) from its last checkpoint. A root this instance is not
 * compatible with is left to another one and logged once. With the in-memory defaults nothing
 * survives a restart, so there is nothing to recover; recovery works with persistent stores.
 */

/** How often an instance looks: the lease length, so an expired lease is found within one more. */
const SWEEP_EVERY: Milliseconds = seconds(30);

/** How many `running` records one look-up reads at a time. */
const PAGE = 50;

/** The recovery sweep of one application instance. */
export interface RecoverySweep {
  /** Stops looking (the first step of a graceful stop); resolves when its recoveries ended. */
  stop(): Promise<void>;
}

/** What the sweep reads and continues: the records, each workflow's recovery by its name, the clock. */
export interface RecoverySources {
  readonly records: ExecutionRecordRepository;
  readonly workflows: ReadonlyMap<string, RecoverRoot>;
  readonly clock: Clock;
  /** Stops the recoveries in flight like the app's other executions (the shutdown timeout). */
  readonly signal: AbortSignal;
}

/** The message of a recovery problem, for the log. */
const problemOf = (
  record: Tern,
  error: unknown,
): { readonly code: string; readonly text: string } =>
  error instanceof IncompatibleResumeError
    ? {
        code: "recovery.incompatible",
        text: `execution ${record.runId ?? record.id} is left to an instance of a compatible version: ${error.message}`,
      }
    : {
        code: "recovery.failed",
        text: `recovery of execution ${record.runId ?? record.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      };

/** One instance's sweep: its look-ups, the recoveries it started, the problems it logged. */
class Sweeper implements RecoverySweep {
  readonly #stopped = new AbortController();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #logged = new Set<string>();
  readonly #loop: Promise<void>;

  constructor(private readonly sources: RecoverySources) {
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    await this.#loop;
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async #run(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      try {
        await this.#sweep();
      } catch (error) {
        // a store that failed is asked again at the next sweep
        this.#log(
          "recovery.failed",
          `recovery could not list the running executions: ${String(error)}`,
        );
      }
      await this.sources.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
    }
  }

  /** Every `running` record, page by page; each one's recovery started, not awaited. */
  async #sweep(): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const page = await this.sources.records.findByStatus(
        ExecutionRecordStatus.Running,
        PAGE,
        after,
      );
      for (const record of page) if (!this.#stopped.signal.aborted) this.#recover(record);
      const last = page.at(-1);
      if (page.length < PAGE || last === undefined || this.#stopped.signal.aborted) return;
      after = last.id;
    }
  }

  #recover(record: Tern): void {
    const recoverRoot = this.sources.workflows.get(record.bundle);
    // another application's record on a shared store, or one already being continued here
    if (recoverRoot === undefined || this.#inFlight.has(record.id)) return;
    const recovery = recoverRoot(record, this.sources.signal)
      .catch((error: unknown) => {
        if (isHandedOver(error)) return;
        const { code, text } = problemOf(record, error);
        this.#log(code, text);
      })
      .finally(() => {
        this.#inFlight.delete(record.id);
      });
    this.#inFlight.set(record.id, recovery);
  }

  /** Each problem once per instance (an incompatible root is seen again every sweep). */
  #log(code: string, text: string): void {
    if (this.#logged.has(text)) return;
    this.#logged.add(text);
    process.emitWarning(text, { code });
  }
}

/** Starts the sweep of one application instance: a look-up now, then every lease length. */
export const startRecoverySweep = (sources: RecoverySources): RecoverySweep => new Sweeper(sources);
