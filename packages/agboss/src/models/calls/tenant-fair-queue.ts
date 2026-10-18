import { QueueBalancingStrategy } from "../policies/rate-limit-policy.js";

/**
 * The waiting calls of one provider in one application instance (#266 S34, S58, S60): grouped by
 * `tenantId` in a ring of buckets, FIFO inside a bucket; which bucket gives the next call is the
 * policy's `balancing`. A waiter that leaves (its signal aborted) leaves its bucket at once, an
 * empty bucket leaves the ring. In-process only: between instances a slot goes to whoever takes
 * the lease first (local fairness).
 */

/** Who a waiting call is for: its tenant and the tenant's weight (`TenantWeighted`). */
export interface QueueTicket {
  readonly tenantId: string;
  /** A positive integer: slots per round under `TenantWeighted` (default 1). */
  readonly weight: number;
}

/** How many calls of a tenant are in flight in this instance (`TenantLeastInFlight`). */
export type InFlightOf = (tenantId: string) => number;

/** Every waiter of a `Fifo` queue is in one bucket. */
const ONE_BUCKET = "\u0000fifo";

export class TenantFairQueue<TWaiter extends QueueTicket> {
  readonly #buckets = new Map<string, TWaiter[]>();
  /** The tenants with waiters, in the order they first waited. */
  readonly #ring: string[] = [];
  /**
   * The ring position served next, in [0, ring length]: past the end means "after the last" — a
   * tenant that starts waiting then is served before the ring starts over.
   */
  #cursor = 0;
  /** Slots the bucket at the cursor got this round (`TenantWeighted`). */
  #served = 0;

  constructor(private readonly strategy: QueueBalancingStrategy) {}

  get size(): number {
    let size = 0;
    for (const bucket of this.#buckets.values()) size += bucket.length;
    return size;
  }

  add(waiter: TWaiter): void {
    const key = this.#keyOf(waiter);
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) {
      bucket.push(waiter);
      return;
    }
    this.#buckets.set(key, [waiter]);
    this.#ring.push(key);
  }

  /** The waiter the next free slot goes to; `undefined` when nobody waits. */
  peek(inFlightOf: InFlightOf): TWaiter | undefined {
    const position = this.#nextPosition(inFlightOf);
    const key = position === undefined ? undefined : this.#ring[position];
    return key === undefined ? undefined : this.#buckets.get(key)?.[0];
  }

  /** `waiter` got the slot: it leaves its bucket and the ring moves on. */
  take(waiter: TWaiter): void {
    const position = this.#ring.indexOf(this.#keyOf(waiter));
    if (position === -1) return;
    if (position !== this.#current()) this.#served = 0;
    this.#cursor = position;
    this.#served += 1;
    const keepsTurn =
      this.strategy === QueueBalancingStrategy.TenantWeighted && this.#served < waiter.weight;
    if (!this.#leave(waiter) && !keepsTurn) this.#moveOn();
  }

  /** Every waiter, in no particular order, and the queue empty (a failed repository fails them). */
  takeAll(): readonly TWaiter[] {
    const all = [...this.#buckets.values()].flat();
    this.#buckets.clear();
    this.#ring.length = 0;
    this.#cursor = 0;
    this.#served = 0;
    return all;
  }

  /** A waiter that stopped waiting (cancelled): it leaves its bucket at once. */
  remove(waiter: TWaiter): void {
    this.#leave(waiter);
  }

  #keyOf(waiter: QueueTicket): string {
    return this.strategy === QueueBalancingStrategy.Fifo ? ONE_BUCKET : waiter.tenantId;
  }

  /** The cursor as a position of the ring (past the end is its start). */
  #current(): number {
    return this.#cursor >= this.#ring.length ? 0 : this.#cursor;
  }

  /** The ring position served next: the cursor's, or the least busy tenant's from the cursor on. */
  #nextPosition(inFlightOf: InFlightOf): number | undefined {
    if (this.#ring.length === 0) return undefined;
    const current = this.#current();
    if (this.strategy !== QueueBalancingStrategy.TenantLeastInFlight) return current;
    let best = current;
    for (let step = 1; step < this.#ring.length; step++) {
      const position = (current + step) % this.#ring.length;
      if (inFlightOf(this.#at(position)) < inFlightOf(this.#at(best))) best = position;
    }
    return best;
  }

  #at(position: number): string {
    return this.#ring[position] ?? "";
  }

  /** Takes the waiter out of its bucket; `true` when that emptied the bucket (it left the ring). */
  #leave(waiter: TWaiter): boolean {
    const key = this.#keyOf(waiter);
    const bucket = this.#buckets.get(key);
    const index = bucket?.indexOf(waiter) ?? -1;
    if (bucket === undefined || index === -1) return false;
    bucket.splice(index, 1);
    if (bucket.length > 0) return false;
    this.#buckets.delete(key);
    const position = this.#ring.indexOf(key);
    this.#ring.splice(position, 1);
    if (position < this.#cursor) this.#cursor -= 1;
    if (position === this.#cursor) this.#served = 0;
    return true;
  }

  #moveOn(): void {
    this.#cursor += 1;
    this.#served = 0;
  }
}
