import type { Clock } from "../../../infrastructure/clock.js";
import type {
  RateLimitLease,
  RateLimitRepository,
} from "../../../infrastructure/rate-limit.repository.js";
import { keepRenewing, SLOT_LEASE } from "../../../models/calls/gate-pass.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import type { SlotClaim } from "./launch-registry.js";
import { holdOnce, SlotQueue, type QueueWatch, type SlotHold } from "./slot-queue.js";

/**
 * The slots of a tree that can launch a child on any instance (#333 PR 3, S8): its
 * `maxConcurrentExecutions` held as leases in the application's `RateLimitRepository`, so the
 * executions of the tree count against one cap whichever instance runs them. As in-process
 * (`TreeSlots`), a slot is an execution's — taken by its first working step, given back when its last
 * one ends, pauses or fails — under the key `tree:<tenantId>:<rootExecutionId>`, and a child's own
 * smaller cap is a second lease under its subtree's key (both or neither). A lease is renewed while
 * held, so a slot of an instance that died frees itself. The steps waiting on this instance keep
 * the queue's order (a branch closing first, then the deepest, aged); a slot freed here lets the
 * next one in at once, one freed on another instance is noticed at the next look (every second, on
 * the `Clock`) — across instances whoever takes the lease first gets it, as a model provider's
 * slots (#266).
 */

/** How often waiting steps look for a slot freed on another instance. */
const POLL: Milliseconds = seconds(1);

/** What a tree's shared slots are kept in: the application's store and clock, the tree's tenant. */
export interface SharedSlotParts {
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
  readonly tenantId: string;
}

/** The leases one execution holds: renewed until released. */
interface HeldLeases {
  release(): void;
}

const NO_LEASES: HeldLeases = { release: () => undefined };

/** How taking an execution's leases went: held, or which cap had no room. */
type Taken =
  | { readonly kind: "held"; readonly held: HeldLeases }
  | { readonly kind: "tree-full" }
  | { readonly kind: "subtree-full" };

/** An execution at work on this instance: its running steps and its leases. */
interface Working {
  steps: number;
  readonly held: HeldLeases;
}

/** The leases of a tree's cap and of each capped subtree of `claim`, outermost first. */
const capsOf = (
  claim: SlotClaim,
  treeKey: string,
  maxConcurrentExecutions: number,
): readonly { readonly key: string; readonly maxSlots: number }[] => [
  { key: treeKey, maxSlots: maxConcurrentExecutions },
  ...claim.subtrees.map((subtree) => ({
    key: `${treeKey}:subtree:${subtree.executionId}`,
    maxSlots: subtree.maxConcurrentExecutions,
  })),
];

export class SharedTreeSlots {
  readonly #working = new Map<string, Working>();
  readonly #reserved = new Map<SlotClaim, HeldLeases>();
  readonly #queue: SlotQueue<SlotClaim>;
  readonly #treeKey: string;
  #isGranting = false;
  /** Looks asked while one ran: it goes round once more. */
  #asked = 0;
  #poll: AbortController | undefined;

  constructor(
    private readonly parts: SharedSlotParts,
    rootExecutionId: string,
    readonly maxConcurrentExecutions: number,
  ) {
    this.#queue = new SlotQueue(parts.clock);
    this.#treeKey = `tree:${parts.tenantId}:${rootExecutionId}`;
  }

  /** Takes a slot for one step of `claim`'s execution; `undefined` when `signal` aborts first. */
  take(claim: SlotClaim, signal: AbortSignal, watch?: QueueWatch): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const waiting = this.#queue.wait(claim, signal, () => this.#hold(claim), watch);
    void this.#grant();
    return waiting;
  }

  #hold(claim: SlotClaim): SlotHold {
    const { executionId } = claim;
    const held = this.#reserved.get(claim) ?? NO_LEASES;
    this.#reserved.delete(claim);
    const working = this.#working.get(executionId) ?? { steps: 0, held };
    working.steps += 1;
    this.#working.set(executionId, working);
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
    working.held.release();
    void this.#grant();
  }

  /** Grants what can work now, one look at a time; a look asked meanwhile runs once more. */
  async #grant(): Promise<void> {
    this.#asked += 1;
    if (this.#isGranting) return;
    this.#isGranting = true;
    try {
      while (this.#asked > 0) {
        this.#asked = 0;
        await this.#grantWaiting();
      }
    } finally {
      this.#isGranting = false;
    }
    this.#pollWhileWaiting();
  }

  /** The waiting steps, best first: each granted while its execution works or takes its leases. */
  async #grantWaiting(): Promise<void> {
    for (const claim of this.#queue.waitingClaims()) {
      if (!this.#working.has(claim.executionId)) {
        const taken = await this.#take(claim);
        if (taken.kind === "tree-full") return;
        if (taken.kind === "subtree-full") continue;
        // it left the queue while its leases were taken (a cancel): they go back
        if (!this.#queue.waitingClaims().includes(claim)) {
          taken.held.release();
          continue;
        }
        this.#reserved.set(claim, taken.held);
      }
      this.#queue.grantReady((waiting) => waiting === claim);
    }
  }

  /** The leases of `claim`'s caps, all or none; a store that fails counts as no room. */
  async #take(claim: SlotClaim): Promise<Taken> {
    const { rateLimits } = this.parts;
    const leases: RateLimitLease[] = [];
    for (const cap of capsOf(claim, this.#treeKey, this.maxConcurrentExecutions)) {
      const lease = await rateLimits
        .acquire(cap.key, cap.maxSlots, SLOT_LEASE)
        .catch(() => undefined);
      if (lease === undefined) {
        this.#heldOf(leases).release();
        return { kind: leases.length === 0 ? "tree-full" : "subtree-full" };
      }
      leases.push(lease);
    }
    return { kind: "held", held: this.#heldOf(leases) };
  }

  /** Leases renewed until released (a failed release or renewal: the lease expires by itself). */
  #heldOf(leases: readonly RateLimitLease[]): HeldLeases {
    const stopped = new AbortController();
    for (const lease of leases)
      void keepRenewing(this.parts, lease, stopped.signal).catch(() => undefined);
    return holdOnce(() => {
      stopped.abort();
      for (const lease of leases) void this.parts.rateLimits.release(lease).catch(() => undefined);
    });
  }

  /** While steps wait, a look every `POLL` for a slot freed on another instance. */
  #pollWhileWaiting(): void {
    if (this.#queue.size === 0) {
      this.#poll?.abort();
      this.#poll = undefined;
      return;
    }
    if (this.#poll !== undefined) return;
    const poll = new AbortController();
    this.#poll = poll;
    void this.parts.clock.sleep(POLL, poll.signal).then(() => {
      if (this.#poll === poll) this.#poll = undefined;
      if (!poll.signal.aborted) void this.#grant();
    });
  }
}
