/**
 * How many files by `url` a listener fetches at once, across every message (#1256): each fetch holds
 * a TLS socket until it ends, and `FileFetches` joins only the duplicates of one message — a caller
 * sending K messages of `maxFiles` urls to a slow origin would hold `maxFiles × K` sockets. A fetch
 * takes a slot; with none free it waits in a queue of `maxQueued`, FIFO, and past the queue it is
 * refused at once (`a2a.file-fetch-busy`): nothing grows without a bound.
 */

import { ComponentError } from "../../components/metadata.js";

/** The fetches a listener runs at once by default. */
export const DEFAULT_MAX_CONCURRENT_FILE_FETCHES = 16;

/** `maxConcurrentFileFetches` or `maxConcurrentFileFetchesPerTenant` as given: a whole number from 1, else `[a2a.file-fetch-limit-invalid]`. */
export function checkedFetchLimit(name: string, limit: number | undefined): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))
    throw new ComponentError({
      message: `[a2a.file-fetch-limit-invalid] a2aHttpListener's ${name} is not a whole number from 1`,
    });
}

/** The queue holds this many fetches per slot. */
export const QUEUED_PER_SLOT = 4;

/** One caller (a tenant) holds at most this part of the slots, by default: a quarter. */
export const TENANT_SHARE = 4;

/** A fetch that waits for a slot: it starts when handed one. */
interface Waiter {
  readonly key: string;
  readonly start: () => void;
}

/** What one caller may hold: slots in use, places in the queue. */
export interface KeyShare {
  readonly running: number;
  readonly queued: number;
}

const bump = (counts: Map<string, number>, key: string, by: number): void => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
};

/**
 * A listener's slots for fetches: `limit` at once and `maxQueued` waiting, and under them each
 * caller's (`key`'s) own share (`perKey`), so that one tenant's flood cannot take every slot and the
 * whole queue: a caller over its share is refused at once, a waiter whose caller is at its slots
 * is passed over until one of that caller's ends.
 */
export class FileFetchSlots {
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #perKey: KeyShare;
  readonly #queue: Waiter[] = [];
  readonly #runningOf = new Map<string, number>();
  readonly #queuedOf = new Map<string, number>();
  #running = 0;

  constructor(limit: number, maxQueued: number, perKey: KeyShare) {
    this.#limit = limit;
    this.#maxQueued = maxQueued;
    this.#perKey = perKey;
  }

  /**
   * `work` once a slot is free, the slot given back when it settles. A queue or the caller's share
   * full: `whenFull()` thrown, nothing started. `signal` aborted while queued: the wait ends with
   * the signal's reason and leaves the queue.
   */
  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    whenFull: () => Error,
    key: string,
  ): Promise<T> {
    await this.#take(signal, whenFull, key);
    try {
      return await work();
    } finally {
      this.#give(key);
    }
  }

  #take(signal: AbortSignal, whenFull: () => Error, key: string): Promise<void> {
    signal.throwIfAborted();
    if (this.#canStart(key)) {
      this.#start(key);
      return Promise.resolve();
    }
    const isQueueFull = this.#queue.length >= this.#maxQueued;
    if (isQueueFull || (this.#queuedOf.get(key) ?? 0) >= this.#perKey.queued)
      return Promise.reject(whenFull());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        start: () => {
          signal.removeEventListener("abort", leave);
          resolve();
        },
      };
      const leave = (): void => {
        this.#queue.splice(this.#queue.indexOf(waiter), 1);
        bump(this.#queuedOf, key, -1);
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", leave);
      this.#queue.push(waiter);
      bump(this.#queuedOf, key, 1);
    });
  }

  /** How many callers have a fetch running or waiting: none once they all end. */
  get callers(): number {
    return new Set([...this.#runningOf.keys(), ...this.#queuedOf.keys()]).size;
  }

  #canStart(key: string): boolean {
    return this.#running < this.#limit && (this.#runningOf.get(key) ?? 0) < this.#perKey.running;
  }

  #start(key: string): void {
    this.#running += 1;
    bump(this.#runningOf, key, 1);
  }

  /** A slot back: handed to the first in line whose caller has room, else free. */
  #give(key: string): void {
    this.#running -= 1;
    bump(this.#runningOf, key, -1);
    const at = this.#queue.findIndex((waiter) => this.#canStart(waiter.key));
    const next = at < 0 ? undefined : this.#queue.splice(at, 1)[0];
    if (next === undefined) return;
    bump(this.#queuedOf, next.key, -1);
    this.#start(next.key);
    next.start();
  }
}

/** A listener's slots: `limit` fetches at once (checked by `checkedFetchLimit`), else the default; a caller's share `perTenant`, else a quarter. */
export function fileSlotsOf(
  limit: number | undefined,
  perTenant: number | undefined,
): FileFetchSlots {
  const total = limit ?? DEFAULT_MAX_CONCURRENT_FILE_FETCHES;
  const running = perTenant ?? Math.max(1, Math.floor(total / TENANT_SHARE));
  return new FileFetchSlots(total, total * QUEUED_PER_SLOT, {
    running: Math.min(running, total),
    queued: running * QUEUED_PER_SLOT,
  });
}

/**
 * The key of a caller's share: its tenant and owner as a JSON array, never a joined text (tenant
 * `a/b` with owner `c` and tenant `a` with owner `b/c` are two callers); a caller with no owner is
 * its tenant's one anonymous bucket (`null`, never an owner's id).
 */
export const callerKeyOf = (tenantId: string, ownerId: string | undefined): string =>
  JSON.stringify([tenantId, ownerId ?? null]);
