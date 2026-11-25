/**
 * How many files by `url` a listener fetches at once, across every message (#1256): each fetch holds
 * a TLS socket until it ends, and `FileFetches` joins only the duplicates of one message — a caller
 * sending K messages of `maxFiles` urls to a slow origin would hold `maxFiles × K` sockets. A fetch
 * takes a slot; with none free it waits in a queue of `maxQueued`, FIFO, and past the queue it is
 * refused at once (`a2a.file-fetch-busy`): nothing grows without a bound. Under the total, two
 * shares (#1297): a tenant's, and inside it each owner's.
 */

/** The fetches a pool runs at once by default (`FileFetchPool.maxConcurrent`). */
export const DEFAULT_MAX_CONCURRENT_FILE_FETCHES = 16;

/** The fetches of one owner a pool runs at once by default (`FileFetchPool.maxConcurrentPerOwner`). */
export const DEFAULT_MAX_CONCURRENT_PER_OWNER = 2;

/** The fetches of one owner a pool holds waiting by default (`FileFetchPool.maxQueuedPerOwner`). */
export const DEFAULT_MAX_QUEUED_PER_OWNER = 8;

/** The queue holds this many fetches per slot. */
export const QUEUED_PER_SLOT = 4;

/** A tenant holds at most this part of the slots by default, and an owner this part of its tenant's: a quarter. */
export const TENANT_SHARE = 4;

/**
 * Whose fetch it is: the key of its tenant's share and, when the execution has an owner, of its
 * own (the owner's) inside it. An ownerless fetch uses its tenant's share directly: it never
 * shares an owner's bucket with the tenant's other ownerless fetches.
 */
export interface FileCaller {
  readonly tenant: string;
  readonly owner?: string | undefined;
}

/** A fetch that waits for a slot: it starts when handed one. */
interface Waiter {
  readonly caller: FileCaller;
  readonly start: () => void;
}

/** What one share may hold: slots in use, places in the queue. */
export interface KeyShare {
  readonly running: number;
  readonly queued: number;
}

const bump = (counts: Map<string, number>, key: string, by: number): void => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
};

/** One level of shares: what each key of it runs and has waiting, against one limit. */
class Level {
  readonly #share: KeyShare;
  readonly #running = new Map<string, number>();
  readonly #queued = new Map<string, number>();

  constructor(share: KeyShare) {
    this.#share = share;
  }

  // an ownerless caller (`key` undefined) holds no share of this level: its tenant's one bounds it
  hasSlot(key: string | undefined): boolean {
    return key === undefined || (this.#running.get(key) ?? 0) < this.#share.running;
  }

  hasPlace(key: string | undefined): boolean {
    return key === undefined || (this.#queued.get(key) ?? 0) < this.#share.queued;
  }

  run(key: string | undefined, by: number): void {
    if (key !== undefined) bump(this.#running, key, by);
  }

  wait(key: string | undefined, by: number): void {
    if (key !== undefined) bump(this.#queued, key, by);
  }

  get keys(): ReadonlySet<string> {
    return new Set([...this.#running.keys(), ...this.#queued.keys()]);
  }
}

/**
 * A listener's slots for fetches: `limit` at once and `maxQueued` waiting, and under them two
 * shares (#1297), so that one tenant's flood — however many owners it has — cannot take every slot
 * and the whole queue: a tenant's (`perTenant`) bounds the sum of its owners, and each owner's
 * (`perOwner`) bounds it inside its tenant. A fetch over either share is refused at once, a waiter
 * whose tenant or owner is at its slots is passed over until one of theirs ends.
 */
export class FileFetchSlots {
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #tenants: Level;
  readonly #owners: Level;
  readonly #queue: Waiter[] = [];
  #running = 0;

  constructor(limit: number, maxQueued: number, perTenant: KeyShare, perOwner: KeyShare) {
    this.#limit = limit;
    this.#maxQueued = maxQueued;
    this.#tenants = new Level(perTenant);
    this.#owners = new Level(perOwner);
  }

  /**
   * `work` once a slot is free, the slot given back when it settles. A queue or the caller's shares
   * full: `whenFull()` thrown, nothing started. `signal` aborted while queued: the wait ends with
   * the signal's reason and leaves the queue.
   */
  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    whenFull: () => Error,
    caller: FileCaller,
  ): Promise<T> {
    await this.#take(signal, whenFull, caller);
    try {
      return await work();
    } finally {
      this.#give(caller);
    }
  }

  #take(signal: AbortSignal, whenFull: () => Error, caller: FileCaller): Promise<void> {
    signal.throwIfAborted();
    if (this.#canStart(caller)) {
      this.#start(caller);
      return Promise.resolve();
    }
    const isQueueFull = this.#queue.length >= this.#maxQueued;
    if (
      isQueueFull ||
      !this.#tenants.hasPlace(caller.tenant) ||
      !this.#owners.hasPlace(caller.owner)
    )
      return Promise.reject(whenFull());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        caller,
        start: () => {
          signal.removeEventListener("abort", leave);
          resolve();
        },
      };
      const leave = (): void => {
        this.#queue.splice(this.#queue.indexOf(waiter), 1);
        this.#unqueue(caller);
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", leave);
      this.#queue.push(waiter);
      this.#tenants.wait(caller.tenant, 1);
      this.#owners.wait(caller.owner, 1);
    });
  }

  /** How many owners have a fetch running or waiting: none once they all end. */
  get callers(): number {
    return this.#owners.keys.size;
  }

  /** How many tenants have a fetch running or waiting: none once they all end. */
  get tenants(): number {
    return this.#tenants.keys.size;
  }

  #canStart(caller: FileCaller): boolean {
    return (
      this.#running < this.#limit &&
      this.#tenants.hasSlot(caller.tenant) &&
      this.#owners.hasSlot(caller.owner)
    );
  }

  #start(caller: FileCaller): void {
    this.#running += 1;
    this.#tenants.run(caller.tenant, 1);
    this.#owners.run(caller.owner, 1);
  }

  #unqueue(caller: FileCaller): void {
    this.#tenants.wait(caller.tenant, -1);
    this.#owners.wait(caller.owner, -1);
  }

  /** A slot back: handed to the first in line whose tenant and owner have room, else free. */
  #give(caller: FileCaller): void {
    this.#running -= 1;
    this.#tenants.run(caller.tenant, -1);
    this.#owners.run(caller.owner, -1);
    const at = this.#queue.findIndex((waiter) => this.#canStart(waiter.caller));
    const next = at < 0 ? undefined : this.#queue.splice(at, 1)[0];
    if (next === undefined) return;
    this.#unqueue(next.caller);
    this.#start(next.caller);
    next.start();
  }
}

const shareOf = (running: number): KeyShare => ({ running, queued: running * QUEUED_PER_SLOT });

/**
 * A pool's slots (`FileFetchPool`, #1316): `maxConcurrent` fetches at once (16), a tenant's share
 * `maxConcurrentPerTenant` (a quarter of them, at least 1), an owner's `maxConcurrentPerOwner` inside
 * its tenant (2, at most half of the tenant's share and at least 1: two owners share a tenant of 2),
 * and `maxQueuedPerOwner` (8) waiting. A share never exceeds the one above it. Whole numbers from 1
 * are checked where a policy is checked (`[file-policy.invalid]`).
 */
export function fileSlotsOf(
  limit: number | undefined,
  perTenant: number | undefined,
  perOwner?: number,
  maxQueuedPerOwner?: number,
): FileFetchSlots {
  const { total, tenant, owner, queued } = effectivePoolOf({
    maxConcurrent: limit,
    maxConcurrentPerTenant: perTenant,
    maxConcurrentPerOwner: perOwner,
    maxQueuedPerOwner,
  });
  return new FileFetchSlots(total, total * QUEUED_PER_SLOT, shareOf(tenant), {
    running: owner,
    queued,
  });
}

/** A pool's numbers with every default filled in and every share held under the one above it. */
export function effectivePoolOf(pool: {
  readonly maxConcurrent?: number | undefined;
  readonly maxConcurrentPerTenant?: number | undefined;
  readonly maxConcurrentPerOwner?: number | undefined;
  readonly maxQueuedPerOwner?: number | undefined;
}): { total: number; tenant: number; owner: number; queued: number } {
  const total = pool.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_FILE_FETCHES;
  const tenant = Math.min(
    pool.maxConcurrentPerTenant ?? Math.max(1, Math.floor(total / TENANT_SHARE)),
    total,
  );
  const owner = Math.min(
    pool.maxConcurrentPerOwner ??
      Math.min(DEFAULT_MAX_CONCURRENT_PER_OWNER, Math.max(1, Math.floor(tenant / 2))),
    tenant,
  );
  return { total, tenant, owner, queued: pool.maxQueuedPerOwner ?? DEFAULT_MAX_QUEUED_PER_OWNER };
}

/** The key of a tenant's share: its id as a JSON array, never a bare text, so it cannot be an owner's key. */
export const tenantKeyOf = (tenantId: string): string => JSON.stringify([tenantId]);

/**
 * The key of an owner's share inside its tenant: the two as a JSON array, never a joined text
 * (tenant `a/b` with owner `c` and tenant `a` with owner `b/c` are two owners). No owner, no key:
 * an ownerless caller uses its tenant's share directly (#1339).
 */
export const callerKeyOf = (tenantId: string, ownerId: string | undefined): string | undefined =>
  ownerId === undefined ? undefined : JSON.stringify([tenantId, ownerId]);
