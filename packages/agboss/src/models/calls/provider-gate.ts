import type { Clock } from "../../infrastructure/clock.js";
import { waitOf } from "../../infrastructure/clock.js";
import type {
  RateLimitLease,
  RateLimitRepository,
} from "../../infrastructure/rate-limit.repository.js";
import { minutes, seconds, type Milliseconds } from "../../units/index.js";
import type { RateLimitPolicy } from "../policies/rate-limit-policy.js";
import { concurrencyAt, halvedAt, type ConcurrencyLevel } from "./concurrency-level.js";
import { heldPass, SLOT_LEASE, type GatePass, type PassRelease } from "./gate-pass.js";
import { waitInQueue, type GateTicket, type Waiter } from "./gate-waiter.js";
import { TenantFairQueue } from "./tenant-fair-queue.js";

/**
 * One provider's `rateLimitPolicy` in one application instance (#266): its waiting calls in the
 * tenant-fair queue, then — for the call the queue picks — the shared caps in `RateLimitRepository`:
 * the pause after a 429, the per-minute tokens and calls, a `maxConcurrentCalls` slot. Room held by
 * another instance is polled for on the clock; a release here lets the next call in at once.
 */

/** What a gate is made of. */
export interface ProviderGateOptions {
  readonly provider: string;
  readonly policy: RateLimitPolicy;
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
}

type Room =
  { readonly kind: "granted"; readonly lease?: RateLimitLease } | { readonly kind: "full" };

const FULL: Room = { kind: "full" };

const granted = (lease: RateLimitLease | undefined): Room =>
  lease === undefined ? { kind: "granted" } : { kind: "granted", lease };
const WINDOW = minutes(1);
/** How often room held elsewhere (another instance's slots, a full window) is asked for again. */
const POLL = seconds(0.25);

export class ProviderGate {
  readonly #queue: TenantFairQueue<Waiter>;
  readonly #inFlight = new Map<string, number>();
  #total = 0;
  #level: ConcurrencyLevel | undefined;
  /** When this instance's last slowdown pause ends (the clock's milliseconds). */
  #pauseEnd = 0;
  #pumping = false;
  #again = false;
  #wake: AbortController | undefined;
  readonly #keys: Readonly<Record<"slots" | "calls" | "tokens" | "cooldown", string>>;

  constructor(private readonly options: ProviderGateOptions) {
    this.#queue = new TenantFairQueue(options.policy.balancing);
    const { provider } = options;
    this.#keys = {
      slots: `${provider}:slots`,
      calls: `${provider}:calls-per-minute`,
      tokens: `${provider}:tokens-per-minute`,
      cooldown: `${provider}:cooldown`,
    };
  }

  /** Waits for room; the ticket's signal ends the wait with its reason (`app.cancel`, a timeout). */
  enter(ticket: GateTicket): Promise<GatePass> {
    return waitInQueue(this.#queue, ticket, () => {
      this.#pump();
    });
  }

  /**
   * A 429: the provider's whole queue pauses for `pause` on every instance (in the repository; a
   * later pause already set is kept), and this instance's effective `maxConcurrentCalls` halves,
   * growing back by one a minute (AIMD) — once per pause: a 429 of a call sent before the pause
   * only extends it.
   */
  async slowDown(pause: Milliseconds): Promise<void> {
    const now = this.options.clock.now().getTime();
    await this.options.rateLimits.pauseUntil(this.#keys.cooldown, new Date(now + pause));
    const max = this.options.policy.maxConcurrentCalls;
    if (max !== undefined && now >= this.#pauseEnd) this.#level = halvedAt(max, this.#level, now);
    this.#pauseEnd = Math.max(this.#pauseEnd, now + pause);
    this.#pump();
  }

  /** The calls this instance lets in at once now (`maxConcurrentCalls` lowered after a 429). */
  allowedNow(): number {
    const max = this.options.policy.maxConcurrentCalls;
    if (max === undefined) return Number.POSITIVE_INFINITY;
    return concurrencyAt(max, this.#level, this.options.clock.now().getTime());
  }

  readonly #inFlightOf = (tenantId: string): number => this.#inFlight.get(tenantId) ?? 0;

  #pump(): void {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      do {
        this.#again = false;
        await this.#grant();
      } while (this.#pumpedAgain());
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.#queue.takeAll()) waiter.fail(failure);
    } finally {
      this.#pumping = false;
    }
  }

  /** Whether a pump was asked for while this one ran (a release, a new waiter). */
  #pumpedAgain(): boolean {
    return this.#again;
  }

  /** Lets waiting calls in while there is room; else sleeps until a pause ends or polls again. */
  async #grant(): Promise<void> {
    for (;;) {
      const waiter = this.#queue.peek(this.#inFlightOf);
      if (waiter === undefined || this.#total >= this.allowedNow()) {
        this.#stopWaking();
        return; // nobody waits, or a release here pumps again
      }
      const pausedUntil = await this.options.rateLimits.pausedUntil(this.#keys.cooldown);
      if (pausedUntil !== undefined) {
        this.#wakeAfter(pausedUntil.getTime() - this.options.clock.now().getTime());
        return;
      }
      const room = await this.#roomFor(waiter);
      if (room.kind === "full") {
        this.#wakeAfter(POLL);
        return;
      }
      if (waiter.isSettled()) {
        if (room.lease !== undefined) await this.options.rateLimits.release(room.lease);
        continue;
      }
      this.#admit(waiter, room.lease);
    }
  }

  /** The shared caps for one call: tokens used below the limit, a free slot, a call left. */
  async #roomFor(waiter: Waiter): Promise<Room> {
    if (!(await this.#tokensLeft())) return FULL;
    const slot = await this.#slot();
    if (slot.kind === "full") return FULL;
    if (waiter.isSettled() || (await this.#callCounted())) return slot;
    if (slot.lease !== undefined) await this.options.rateLimits.release(slot.lease);
    return FULL;
  }

  /** `perMinute.tokens`: whether the window's used tokens are below the limit (or none is set). */
  async #tokensLeft(): Promise<boolean> {
    const { tokens } = this.options.policy.perMinute;
    if (tokens === undefined) return true;
    const used = await this.options.rateLimits.addToWindow(this.#keys.tokens, 0, WINDOW);
    return (used ?? 0) < tokens;
  }

  /** A `maxConcurrentCalls` slot (no lease without that limit); full while every slot is taken. */
  async #slot(): Promise<Room> {
    const max = this.options.policy.maxConcurrentCalls;
    if (max === undefined) return granted(undefined);
    const lease = await this.options.rateLimits.acquire(this.#keys.slots, max, SLOT_LEASE);
    return lease === undefined ? FULL : granted(lease);
  }

  /** `perMinute.calls`: the call counted in the window, or `false` when the window is full. */
  async #callCounted(): Promise<boolean> {
    const { calls } = this.options.policy.perMinute;
    if (calls === undefined) return true;
    return (
      (await this.options.rateLimits.addToWindow(this.#keys.calls, 1, WINDOW, calls)) !== undefined
    );
  }

  #admit(waiter: Waiter, lease: RateLimitLease | undefined): void {
    this.#queue.take(waiter);
    this.#total += 1;
    this.#inFlight.set(waiter.tenantId, this.#inFlightOf(waiter.tenantId) + 1);
    const { rateLimits, clock } = this.options;
    const onRelease = (release: PassRelease): Promise<void> => this.#released(release);
    waiter.admit(heldPass({ rateLimits, clock, onRelease }, lease, waiter.tenantId));
  }

  async #released({ tenantId, tokens }: PassRelease): Promise<void> {
    this.#total -= 1;
    const left = this.#inFlightOf(tenantId) - 1;
    if (left > 0) this.#inFlight.set(tenantId, left);
    else this.#inFlight.delete(tenantId);
    try {
      if (tokens > 0 && this.options.policy.perMinute.tokens !== undefined) {
        await this.options.rateLimits.addToWindow(this.#keys.tokens, tokens, WINDOW);
      }
    } finally {
      this.#pump();
    }
  }

  #wakeAfter(delay: number): void {
    this.#stopWaking();
    const timer = new AbortController();
    this.#wake = timer;
    void this.options.clock.sleep(waitOf(delay), timer.signal).then(() => {
      if (timer.signal.aborted) return;
      this.#wake = undefined;
      this.#pump();
    });
  }

  #stopWaking(): void {
    this.#wake?.abort();
    this.#wake = undefined;
  }
}
