/**
 * Naive stores at the lease's boundary (#534 acceptance): each lets a lease live on for its holder
 * at or past `expiresAt`, the way a hand-written store does — matching only the holder and the epoch
 * (the core's stores before #534), or comparing `expiresAt >= now` (PostgreSQL's before #534) — so
 * the boundary cases of the published suites are shown to bite. `naive-expiry.contract-fixture.ts`
 * runs them, `expiry-bites.test.ts` reads the failures.
 */
import { Clock } from "../../../src/infrastructure/clock.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../../src/infrastructure/execution-lease.repository.js";
import {
  treeKeyOf,
  type ExecutionLeaseRow,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import type { ApplicationContext } from "../../../src/flow/context/application-context.js";
import type { Milliseconds } from "../../../src/units/index.js";

/** Whether a naive store still lets the holder keep a lease that ends at `expiresAt`, at `now`. */
export type HolderLiveness = (expiresAt: number, now: number) => boolean;

/** The core's stores before #534: the holder and the epoch only — never the time. */
export const holderAndEpochOnly: HolderLiveness = () => true;

/** PostgreSQL's before #534: `expires_at >= now` — the instant of expiry still the holder's. */
export const throughExpiry: HolderLiveness = (expiresAt, now) => expiresAt >= now;

/** An in-memory lease store whose `renew`, `yield` and `reclaim` judge the holder by `liveness`. */
export class NaiveExpiryLeaseRepository extends InMemoryExecutionLeaseRepository {
  constructor(
    private readonly time: Clock,
    application: ApplicationContext,
    private readonly rows: InMemoryDatabase,
    private readonly liveness: HolderLiveness,
  ) {
    super(time, application, rows);
  }

  override renew(lease: ExecutionLease, length: Milliseconds): Promise<boolean> {
    const stored = this.#held(lease);
    if (stored !== undefined)
      this.#write(lease, { ...stored.lease, expiresAt: this.#from(length) });
    return Promise.resolve(stored !== undefined);
  }

  override yield(lease: ExecutionLease): Promise<boolean> {
    const stored = this.#held(lease);
    if (stored !== undefined)
      this.rows.executionLeases.set(this.#key(lease), { ...stored, isYielded: true });
    return Promise.resolve(stored !== undefined);
  }

  override reclaim(
    lease: ExecutionLease,
    length: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const stored = this.#held(lease);
    if (stored === undefined) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId, leaseEpoch } = stored.lease;
    const reclaimed = {
      tenantId,
      rootExecutionId,
      holderInstanceId,
      leaseEpoch: leaseEpoch + 1,
      expiresAt: this.#from(length),
    };
    this.rows.executionLeases.set(this.#key(lease), { lease: reclaimed, released: false });
    return Promise.resolve(reclaimed);
  }

  #key(lease: ExecutionLease): string {
    return treeKeyOf(lease.tenantId, lease.rootExecutionId);
  }

  #from(length: Milliseconds): Date {
    return new Date(this.time.now().getTime() + length);
  }

  #write(lease: ExecutionLease, next: ExecutionLease): void {
    const stored = this.rows.executionLeases.get(this.#key(lease));
    if (stored !== undefined)
      this.rows.executionLeases.set(this.#key(lease), { ...stored, lease: next });
  }

  #held(lease: ExecutionLease): ExecutionLeaseRow | undefined {
    const stored = this.rows.executionLeases.get(this.#key(lease));
    const isSame =
      stored !== undefined &&
      !stored.released &&
      stored.lease.leaseEpoch === lease.leaseEpoch &&
      stored.lease.holderInstanceId === lease.holderInstanceId;
    const isLive =
      isSame && this.liveness(stored.lease.expiresAt.getTime(), this.time.now().getTime());
    return isLive ? stored : undefined;
  }
}

/**
 * The time a fencing store reads, `lag` behind the lease store's: a check `expiresAt > now` on it
 * is `expiresAt >= now` for a lag of 1 ms, and no check of the time at all for an hour.
 */
export class LaggingClock extends Clock {
  constructor(
    private readonly time: Clock,
    private readonly lag: Milliseconds,
  ) {
    super();
  }

  now(): Date {
    return new Date(this.time.now().getTime() - this.lag);
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return this.time.sleep(delay, signal);
  }
}

/**
 * An in-memory lease store whose `renew` extends the lease from its old end instead of from now —
 * a renewal 1 ms short of the end gives the holder a lease and 1 ms past the boundary.
 */
export class FromOldEndLeaseRepository extends InMemoryExecutionLeaseRepository {
  constructor(
    private readonly time: Clock,
    application: ApplicationContext,
    private readonly rows: InMemoryDatabase,
  ) {
    super(time, application, rows);
  }

  override async renew(lease: ExecutionLease, length: Milliseconds): Promise<boolean> {
    const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
    const end = this.rows.executionLeases.get(key)?.lease.expiresAt.getTime();
    if (!(await super.renew(lease, length)) || end === undefined) return false;
    const stored = this.rows.executionLeases.get(key);
    if (stored !== undefined && this.time.now().getTime() < end)
      this.rows.executionLeases.set(key, {
        ...stored,
        lease: { ...stored.lease, expiresAt: new Date(end + length) },
      });
    return true;
  }
}
