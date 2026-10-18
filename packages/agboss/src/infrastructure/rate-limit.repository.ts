import { randomUUID } from "node:crypto";
import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock } from "./clock.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import type { InMemoryDatabase, WindowEntry } from "./in-memory-database.js";

/** One slot taken under a key (a model provider's `maxConcurrentCalls`, #266), held as a lease. */
export interface RateLimitLease {
  /** What the slots limit, e.g. the model provider's name. */
  readonly key: string;
  /** This slot among the key's slots. */
  readonly slotId: string;
  /** The application instance that holds it. */
  readonly holderInstanceId: string;
  /** When the slot is free again unless renewed (the framework's clock). */
  readonly expiresAt: Date;
}

/**
 * Infrastructure (#265): concurrency slots shared by every application instance — at most
 * `maxSlots` leases under one key at a time, each expiring by itself, so a slot of an instance
 * that died is free again after its lease. Atomic; `acquire` / `renew` / `release` are named by
 * meaning (an accepted exception to Spring Data names). Used by the model providers' rate limits
 * (#266). Listed only in `@Application({ providers })`; the built-in default is in memory. Your
 * own `extends RateLimitRepository`; time values come from the framework's clock.
 */
export abstract class RateLimitRepository {
  /** A slot under `key` for `lease` from now; `undefined` while `maxSlots` valid leases hold it. */
  abstract acquire(
    key: string,
    maxSlots: number,
    lease: Milliseconds,
  ): Promise<RateLimitLease | undefined>;

  /** Extends the slot by `lease` from now; `false` when it expired (its place may be given away). */
  abstract renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean>;

  /** Frees the slot at once. */
  abstract release(rateLimitLease: RateLimitLease): Promise<void>;

  /**
   * Counts `amount` now under `key`, in a sliding `window` (one window per key), unless the total
   * counted in the last `window` would pass `limit`: the new total, or `undefined` when refused
   * (nothing is counted). `amount` 0 reads the total. Atomic across instances (#266: a provider's
   * `perMinute` calls and tokens, the failures of its circuit breaker).
   */
  abstract addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined>;

  /** Forgets everything counted under `key` (a circuit breaker's failures after a success). */
  abstract clearWindow(key: string): Promise<void>;

  /**
   * Pauses `key` until `until` — a provider's queue after a 429, an open circuit breaker (#266 S58,
   * #265 S52), on every instance at once; a later pause already stored is kept.
   */
  abstract pauseUntil(key: string, until: Date): Promise<void>;

  /** When `key`'s pause ends; `undefined` when it is not paused (an ended pause included). */
  abstract pausedUntil(key: string): Promise<Date | undefined>;
}

/** The entries still inside `window` (ending now). */
const insideWindow = (
  entries: readonly WindowEntry[],
  now: number,
  window: Milliseconds,
): readonly WindowEntry[] => entries.filter((entry) => now - entry.at < window);

const totalOf = (entries: readonly WindowEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.amount, 0);

/**
 * The built-in default: the slots in this instance's memory; every operation is one synchronous
 * step, so it is atomic. The instances of one test share it.
 */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class InMemoryRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly database: InMemoryDatabase,
  ) {
    super();
  }

  /** The key's slots whose lease has not expired. */
  #validSlots(key: string): readonly RateLimitLease[] {
    const now = this.clock.now();
    return (this.database.rateLimitSlots.get(key) ?? []).filter((slot) => slot.expiresAt > now);
  }

  acquire(key: string, maxSlots: number, lease: Milliseconds): Promise<RateLimitLease | undefined> {
    const valid = this.#validSlots(key);
    if (valid.length >= maxSlots) return Promise.resolve(undefined);
    const slot: RateLimitLease = {
      key,
      slotId: randomUUID(),
      holderInstanceId: this.applicationContext.instanceId,
      expiresAt: new Date(this.clock.now().getTime() + lease),
    };
    this.database.rateLimitSlots.set(key, [...valid, slot]);
    return Promise.resolve(slot);
  }

  renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const valid = this.#validSlots(rateLimitLease.key);
    if (!valid.some((slot) => slot.slotId === rateLimitLease.slotId)) return Promise.resolve(false);
    const expiresAt = new Date(this.clock.now().getTime() + lease);
    const renewed = valid.map((slot) =>
      slot.slotId === rateLimitLease.slotId ? { ...slot, expiresAt } : slot,
    );
    this.database.rateLimitSlots.set(rateLimitLease.key, renewed);
    return Promise.resolve(true);
  }

  release(rateLimitLease: RateLimitLease): Promise<void> {
    const left = this.#validSlots(rateLimitLease.key).filter(
      (slot) => slot.slotId !== rateLimitLease.slotId,
    );
    this.database.rateLimitSlots.set(rateLimitLease.key, left);
    return Promise.resolve();
  }

  addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    const now = this.clock.now().getTime();
    const kept = insideWindow(this.database.rateLimitWindows.get(key) ?? [], now, window);
    const total = totalOf(kept) + amount;
    if (limit !== undefined && total > limit) {
      this.database.rateLimitWindows.set(key, kept);
      return Promise.resolve(undefined);
    }
    this.database.rateLimitWindows.set(key, amount === 0 ? kept : [...kept, { at: now, amount }]);
    return Promise.resolve(total);
  }

  clearWindow(key: string): Promise<void> {
    this.database.rateLimitWindows.delete(key);
    return Promise.resolve();
  }

  pauseUntil(key: string, until: Date): Promise<void> {
    const stored = this.database.rateLimitPauses.get(key);
    if (stored === undefined || stored < until) this.database.rateLimitPauses.set(key, until);
    return Promise.resolve();
  }

  pausedUntil(key: string): Promise<Date | undefined> {
    const stored = this.database.rateLimitPauses.get(key);
    return Promise.resolve(stored !== undefined && stored > this.clock.now() ? stored : undefined);
  }
}
