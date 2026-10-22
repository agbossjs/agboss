import type { UsageRecord } from "../../../finops/usage.js";
import type { Clock } from "../../../infrastructure/clock.js";
import type { LiveQuorum } from "./quorum-branch.js";
import type { StepSlots } from "../../../app/step-slots.js";
import type { StepEntries } from "../step-entries.js";
import {
  holdOnce,
  SlotQueue,
  type QueueClaim,
  type QueueWatch,
  type SlotHold,
} from "./slot-queue.js";

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
 * The tree's concurrency cap (#264 S27): `@Workflow({ maxConcurrentExecutions })` of the root — how
 * many executions of one tree (the root and all its descendants) work at once. A priority semaphore
 * per tree, in-process: only the tree's lease holder moves it (Q58) and its children are subgraphs
 * of its checkpoint (#263 S24), so its slots never leave this process — no storage contract.
 *
 * A slot is an execution, not a step: an execution holds one while at least one of its steps runs
 * (parallel branches of one execution share it) and gives it back when its last running step ends,
 * pauses or fails — so an execution waiting at a join or for its child holds none, and the tree
 * cannot deadlock. A step without a free slot waits in the queue (a throttle, never an error) in
 * this order: a parent whose children have all finished (it closes a branch), then the deepest
 * execution; every `AGING_STEP` of waiting counts as one level deeper, read from the application's
 * `Clock` when a slot frees. A child workflow's own, smaller `maxConcurrentExecutions` caps its
 * subtree inside the tree's. A waiter whose signal aborts (a cancel, a `FailFast` launch) leaves the
 * queue (`slot-queue.ts`, shared with the instance's `StepSlots`, #332). After a pause or a crash the next pass makes the tree's slots anew: the unfinished tasks
 * claim them again (a resume elsewhere starts with no slot held).
 */

/** An execution of the tree whose workflow caps its subtree below the caps around it. */
export interface SubtreeCap {
  readonly executionId: string;
  readonly maxConcurrentExecutions: number;
}

/** A step's claim on its tree's slots: its execution and that execution's place in the queue. */
export interface SlotClaim extends QueueClaim {
  readonly executionId: string;
  /** The capped subtrees it is in, outermost first. */
  readonly subtrees: readonly SubtreeCap[];
}

/** An execution at work: its running steps and the capped subtrees it counts in. */
interface Working {
  steps: number;
  readonly subtrees: readonly string[];
}

/** The tree's slots: a priority semaphore of `maxConcurrentExecutions` executions. */
export class TreeSlots {
  readonly #working = new Map<string, Working>();
  readonly #subtreeWork = new Map<string, number>();
  readonly #queue: SlotQueue<SlotClaim>;

  constructor(
    readonly maxConcurrentExecutions: number,
    clock: Clock,
  ) {
    this.#queue = new SlotQueue(clock);
  }

  /** Takes a slot for one step of `claim`'s execution; `undefined` when `signal` aborts first. */
  take(claim: SlotClaim, signal: AbortSignal, watch?: QueueWatch): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#canWork(claim)) return Promise.resolve(this.#hold(claim));
    return this.#queue.wait(claim, signal, () => this.#hold(claim), watch);
  }

  #canWork(claim: SlotClaim): boolean {
    if (this.#working.has(claim.executionId)) return true;
    if (this.#working.size >= this.maxConcurrentExecutions) return false;
    return claim.subtrees.every(
      (subtree) =>
        (this.#subtreeWork.get(subtree.executionId) ?? 0) < subtree.maxConcurrentExecutions,
    );
  }

  #hold(claim: SlotClaim): SlotHold {
    const { executionId } = claim;
    const found = this.#working.get(executionId);
    if (found !== undefined) found.steps += 1;
    else {
      const subtrees = claim.subtrees.map((subtree) => subtree.executionId);
      this.#working.set(executionId, { steps: 1, subtrees });
      for (const id of subtrees) this.#subtreeWork.set(id, (this.#subtreeWork.get(id) ?? 0) + 1);
    }
    return holdOnce(() => {
      this.#release(executionId);
    });
  }

  #release(executionId: string): void {
    const working = this.#working.get(executionId);
    if (working === undefined) return;
    working.steps -= 1;
    if (working.steps > 0) return;
    this.#working.delete(executionId);
    for (const id of working.subtrees)
      this.#subtreeWork.set(id, (this.#subtreeWork.get(id) ?? 1) - 1);
    // the waiting claims that may work now, best first (a granted execution's other steps too)
    this.#queue.grantReady((waiting) => this.#canWork(waiting));
  }
}

/**
 * The trees of one pass by `rootExecutionId` (#264 S27, next to the launch registry of #273 S20):
 * made on a tree's first step, gone with the pass — the next pass rebuilds them from the tasks
 * that are still unfinished. It carries the instance's step slots (#332), which outlive every pass.
 */
export class TreeSlotRegistry {
  readonly #trees = new Map<string, TreeSlots>();

  /**
   * `instance`: the application instance's step slots (#332), when it caps them; `steps`: its
   * running step bodies (#367), when it runs in an application.
   */
  constructor(
    readonly instance?: StepSlots,
    readonly steps?: StepEntries,
  ) {}

  /** The tree's slots, made on its first claim with the root's cap. */
  slotsOf(rootExecutionId: string, maxConcurrentExecutions: number, clock: Clock): TreeSlots {
    const tree = this.#trees.get(rootExecutionId) ?? new TreeSlots(maxConcurrentExecutions, clock);
    this.#trees.set(rootExecutionId, tree);
    return tree;
  }
}
