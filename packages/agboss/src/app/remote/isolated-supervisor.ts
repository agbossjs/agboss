import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import { SWEEP_EVERY } from "../../infrastructure/recovery.js";
import { treeKeyOf } from "../../infrastructure/in-memory-database.js";
import { remoteChildSignals } from "../../flow/runtime/remote/remote-child-signals.js";
import type { SlotHold } from "../../flow/runtime/launch/slot-queue.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import type { ProfileSelection } from "../../config/profile-names.js";
import type { StepHolds } from "../step-slots.js";
import { ChildQueueWatch } from "./child-queue-watch.js";

/**
 * The supervisor of one application instance's isolated workers (#1286b, D9): it only forks. A child
 * queued with `ChildPlacement.IsolatedWorker` is never claimed by a general worker; the supervisor
 * reads such rows (when one is queued in this process, when the store's watch wakes it, and at every
 * sweep) and starts one process per row. The process is a worker of its own — its own `instanceId`,
 * a claim of that one child by its id — that exits when the child ends or pauses. A row that is
 * `Queued` again (the child was paused and resumed; its fork died and a live worker reclaimed it)
 * is forked again. Each live fork holds one of the instance's step slots (#332), so an instance
 * with `maxConcurrentSteps` never runs more forks than it has slots; without a cap there is no limit.
 */

/** What a fork is started with: its child, the entry module and the environment of the instance. */
export interface ForkSpec {
  /** The entry module (`@Application({ isolatedWorker: { entry } })`). */
  readonly entry: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The environment the instance runs with (`createApp(App, { env })`); absent = the default one. */
  readonly environmentName?: string | undefined;
  /** The profiles `createApp({ profile })` named, as given; absent = the default one. */
  readonly profile?: ProfileSelection | undefined;
  /** The temporary SQLite file the instance's database is (`SqliteDriver.inMemory()`): the fork opens the same one. */
  readonly databasePath?: string | undefined;
}

/** One started process. */
export interface ForkHandle {
  /** Resolves, never rejects, once the process is gone (it exited, or could not start). */
  readonly exited: Promise<void>;
  /** Asks it to stop gracefully (SIGTERM): its application closes, its child stays `Running`. */
  terminate(): void;
  /** Ends it now (SIGKILL). */
  kill(): void;
}

/** Starts a process for `spec`: a child process in production, a recorder in a test. */
export type ForkLauncher = (spec: ForkSpec) => ForkHandle;

/** The child queue and the slots the supervisor reads. */
export interface IsolatedSupervisorParts {
  readonly queue: ChildExecutionQueueRepository;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  readonly spec: Omit<ForkSpec, "tenantId" | "executionId">;
  readonly launch: ForkLauncher;
  /** The instance's step slots (#332); absent = no cap. */
  readonly slots?: StepHolds | undefined;
  /** Aborted at the end of the instance's stop (its shutdown timeout): the forks still there are ended. */
  readonly deadline: AbortSignal;
}

export interface IsolatedSupervisor {
  /** Stops looking, asks the forks to close and ends the ones still there at the stop's deadline. */
  stop(): Promise<void>;
}

/** How many queued rows one look reads. */
const LOOK_LIMIT = 64;
/** A child whose fork just ended is not forked again for this long: a fork that cannot start does not spin. */
const REFORK_BACKOFF: Milliseconds = seconds(1);

interface RunningFork {
  readonly handle: ForkHandle;
  readonly hold: SlotHold | undefined;
}

class Supervisor implements IsolatedSupervisor {
  readonly #stopped = new AbortController();
  readonly #forks = new Map<string, RunningFork>();
  /** The clock's millisecond each child was forked last. */
  readonly #forkedAt = new Map<string, number>();
  readonly #watch: ChildQueueWatch;
  readonly #unsubscribe: () => void;
  readonly #loop: Promise<void>;
  #looking: Promise<void> | undefined;
  #asked = false;
  #isRetrying = false;

  constructor(private readonly parts: IsolatedSupervisorParts) {
    const onQueued = (): void => void this.#look();
    this.#unsubscribe = remoteChildSignals.onQueued(onQueued);
    this.#watch = new ChildQueueWatch(parts.queue, onQueued, parts.log);
    this.#loop = this.#sweep();
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    this.#unsubscribe();
    await this.#loop;
    await this.#watch.close();
    await this.#looking;
    const live = [...this.#forks.values()];
    for (const fork of live) fork.handle.terminate();
    const exited = Promise.all(live.map((fork) => fork.handle.exited));
    const kill = (): void => {
      for (const fork of live) fork.handle.kill();
    };
    if (this.parts.deadline.aborted) kill();
    else this.parts.deadline.addEventListener("abort", kill, { once: true });
    await exited;
  }

  async #sweep(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      await this.#watch.open();
      await this.#look();
      await this.parts.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
    }
  }

  /** A look now; one asked while another runs is run right after it. */
  #look(): Promise<void> {
    this.#asked = true;
    this.#looking ??= this.#drain().finally(() => {
      this.#looking = undefined;
    });
    return this.#looking;
  }

  async #drain(): Promise<void> {
    while (this.#asked && !this.#stopped.signal.aborted) {
      this.#asked = false;
      await this.#forkQueued();
    }
  }

  async #forkQueued(): Promise<void> {
    const { queue, log } = this.parts;
    let rows: readonly QueuedChildExecution[];
    try {
      rows = await queue.findQueuedIsolatedWorkerChildren(LOOK_LIMIT);
    } catch (error) {
      log.warn("child-queue.failed", `the child queue could not be read: ${String(error)}`, {});
      return;
    }
    for (const row of rows) {
      if (this.#stopped.signal.aborted) return;
      const key = treeKeyOf(row.tenantId, row.executionId);
      if (this.#forks.has(key)) continue;
      if (this.#isRecent(key)) {
        this.#lookAgainSoon();
        continue;
      }
      const hold = await this.#slotFor(row);
      if (hold === null) return;
      this.#start(row, key, hold);
    }
  }

  #isRecent(key: string): boolean {
    const at = this.#forkedAt.get(key);
    return at !== undefined && this.parts.clock.now().getTime() - at < REFORK_BACKOFF;
  }

  /** A step slot of the instance for a fork: `undefined` without a cap, `null` when none is free. */
  async #slotFor(row: QueuedChildExecution): Promise<SlotHold | undefined | null> {
    const { slots } = this.parts;
    if (slots === undefined) return undefined;
    if (slots.freeSlots() <= 0) return null;
    const hold = await slots.take({ depth: row.depth, closesBranch: false }, this.#stopped.signal);
    return hold ?? null;
  }

  #lookAgainSoon(): void {
    if (this.#isRetrying) return;
    this.#isRetrying = true;
    void this.parts.clock.sleep(REFORK_BACKOFF, this.#stopped.signal).then(() => {
      this.#isRetrying = false;
      if (!this.#stopped.signal.aborted) void this.#look();
    });
  }

  #start(row: QueuedChildExecution, key: string, hold: SlotHold | undefined): void {
    const { tenantId, executionId } = row;
    this.#forkedAt.set(key, this.parts.clock.now().getTime());
    let handle: ForkHandle;
    try {
      handle = this.parts.launch({ ...this.parts.spec, tenantId, executionId });
    } catch (error) {
      hold?.release();
      this.parts.log.error(
        "isolated-worker.fork-failed",
        `the process of child execution ${executionId} did not start: ${String(error)}`,
        { executionId, tenantId },
      );
      this.#lookAgainSoon();
      return;
    }
    this.#forks.set(key, { handle, hold });
    void handle.exited.then(() => {
      this.#forks.delete(key);
      hold?.release();
      if (!this.#stopped.signal.aborted) void this.#look();
    });
  }
}

export const startIsolatedSupervisor = (parts: IsolatedSupervisorParts): IsolatedSupervisor =>
  new Supervisor(parts);
