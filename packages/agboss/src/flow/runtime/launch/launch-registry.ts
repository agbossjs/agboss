import type { UsageRecord } from "../../../finops/usage.js";
import type { QuorumState } from "./quorum.js";
import type { QueueTime } from "./deadline.js";
import type { Clock } from "../../../infrastructure/clock.js";
import { TreeSlots } from "../tree-slots.js";

/**
 * What the process keeps of a launch while it runs (#273 S20), per launch id: the semaphore of
 * `maxConcurrency` (a sliding window: a branch takes a slot when it starts and frees it when it ends,
 * fails, is cancelled or pauses), the `AbortController` a `FailFast` failure aborts, the spend of
 * the branches that ended (so a later branch checks the money limits against it) and the errors
 * themselves (thrown as they are when no `.onJoinError(…)` takes them), and — for a quorum (#279
 * S26) — its state, rebuilt from the finished branches' records when the entry is made anew. In-process
 * is enough: only the tree's lease holder moves a tree (Q58); after a crash or a resume the entry is
 * made anew. Next to the launches, the trees' concurrency caps of the pass (#264 S27,
 * `TreeSlotRegistry`): the same in-process reasoning holds for them.
 */

/** A counting semaphore whose waiters leave when the launch is aborted. */
export class Semaphore {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  /** Takes a slot; resolves `false` when `signal` aborts first (the slot is not taken). */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const take = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = (): void => {
        this.waiting.splice(this.waiting.indexOf(take), 1);
        resolve(false);
      };
      this.waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /** Frees a slot: the next waiter takes it at once. */
  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.free += 1;
    else next();
  }
}

/** A quorum in this process: its state, once rebuilt, and the signal that stops its deadline. */
export interface LiveQuorum {
  readonly state: QuorumState;
  /** Resolves when the state holds the records of the branches that finished before (a resume). */
  readonly ready: Promise<void>;
  readonly stop: AbortController;
  /** The time its branches waited in the tree's queue: its deadline excludes it (#264). */
  readonly queued: QueueTime;
}

/** One launch in this process. */
export interface LiveLaunch {
  readonly slots: Semaphore;
  readonly controller: AbortController;
  /** What the branches that ended spent (in-process: their writes reach the state at the join). */
  readonly spent: UsageRecord[];
  /** The errors of failed branches by ticket index, as they were thrown. */
  readonly errors: Map<number, unknown>;
  /** A quorum join's state (#279). */
  readonly quorum?: LiveQuorum;
}

/** Makes a launch's quorum when its entry is made (it may abort the launch: the quorum is decided). */
export type QuorumMaker = (controller: AbortController) => LiveQuorum | undefined;

/** The launches of one execution graph, by launch id. */
export class LaunchRegistry {
  private readonly live = new Map<string, LiveLaunch>();

  /** The launch's entry, made on its first branch (here, or again after a resume). */
  liveOf(launchId: string, maxConcurrency: number, makeQuorum?: QuorumMaker): LiveLaunch {
    const found = this.live.get(launchId);
    if (found !== undefined) return found;
    const controller = new AbortController();
    const quorum = makeQuorum?.(controller);
    const made: LiveLaunch = {
      slots: new Semaphore(maxConcurrency),
      controller,
      spent: [],
      errors: new Map(),
      ...(quorum === undefined ? {} : { quorum }),
    };
    this.live.set(launchId, made);
    return made;
  }

  /** The entry, when this process ran a branch of the launch. */
  find(launchId: string): LiveLaunch | undefined {
    return this.live.get(launchId);
  }

  /** Removed when the join has read the launch (a quorum's deadline stops). */
  remove(launchId: string): void {
    this.live.get(launchId)?.quorum?.stop.abort();
    this.live.delete(launchId);
  }
}

/**
 * The errors of failed branches across the passes of one process (#267 AC10): a `FailFast`
 * failure withdraws its paused siblings, and the join runs in the next pass — a new graph, a new
 * registry — so the error the branch threw is kept here, as it was thrown, for the join to route
 * (`.onJoinError`) and rethrow. One per workflow of an application instance; a launch's entries go
 * with its join, an execution's with its tree. Another instance has the branch's record only.
 */
export class BranchErrors {
  readonly #errors = new Map<string, unknown>();

  keep(launchId: string, index: number, error: unknown): void {
    this.#errors.set(`${launchId}#${String(index)}`, error);
  }

  /** The error the branch threw, when this process ran it. */
  find(launchId: string, index: number): unknown {
    return this.#errors.get(`${launchId}#${String(index)}`);
  }

  /** Forgets a launch's errors (its join read them). */
  forgetLaunch(launchId: string): void {
    for (const key of this.#errors.keys())
      if (key.startsWith(`${launchId}#`)) this.#errors.delete(key);
  }

  /** Forgets an execution's errors (its tree ended); a launch id starts with the execution's id. */
  forgetExecution(executionId: string): void {
    for (const key of this.#errors.keys()) {
      if (key.startsWith(`${executionId}:`)) this.#errors.delete(key);
    }
  }
}

/**
 * The trees of one pass by `rootExecutionId` (#264 S27, next to the launch registry of #273 S20):
 * made on a tree's first step, gone with the pass — the next pass rebuilds them from the tasks
 * that are still unfinished.
 */
export class TreeSlotRegistry {
  readonly #trees = new Map<string, TreeSlots>();

  /** The tree's slots, made on its first claim with the root's cap. */
  slotsOf(rootExecutionId: string, maxConcurrentExecutions: number, clock: Clock): TreeSlots {
    const tree = this.#trees.get(rootExecutionId) ?? new TreeSlots(maxConcurrentExecutions, clock);
    this.#trees.set(rootExecutionId, tree);
    return tree;
  }
}
