import { randomUUID } from "node:crypto";
import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import { INFRASTRUCTURE_CLOCK, INSTANCE_ID, IN_MEMORY_DATABASE } from "./clock.js";
import type { InMemoryDatabase } from "./in-memory-database.js";

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
}

/**
 * The built-in default: the slots in this instance's memory; every operation is one synchronous
 * step, so it is atomic. The instances of one test share it.
 */
@Injectable({ deps: [INFRASTRUCTURE_CLOCK, INSTANCE_ID, IN_MEMORY_DATABASE] })
export class InMemoryRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly now: () => Date,
    private readonly instanceId: string,
    private readonly database: InMemoryDatabase,
  ) {
    super();
  }

  /** The key's slots whose lease has not expired. */
  #validSlots(key: string): readonly RateLimitLease[] {
    const now = this.now();
    return (this.database.rateLimitSlots.get(key) ?? []).filter((slot) => slot.expiresAt > now);
  }

  acquire(key: string, maxSlots: number, lease: Milliseconds): Promise<RateLimitLease | undefined> {
    const valid = this.#validSlots(key);
    if (valid.length >= maxSlots) return Promise.resolve(undefined);
    const slot: RateLimitLease = {
      key,
      slotId: randomUUID(),
      holderInstanceId: this.instanceId,
      expiresAt: new Date(this.now().getTime() + lease),
    };
    this.database.rateLimitSlots.set(key, [...valid, slot]);
    return Promise.resolve(slot);
  }

  renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const valid = this.#validSlots(rateLimitLease.key);
    if (!valid.some((slot) => slot.slotId === rateLimitLease.slotId)) return Promise.resolve(false);
    const expiresAt = new Date(this.now().getTime() + lease);
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
}
