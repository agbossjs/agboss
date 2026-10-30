import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock } from "./clock.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import { treeKeyOf, type ExecutionLeaseRow, type InMemoryDatabase } from "./in-memory-database.js";

/**
 * The lease of one execution tree (#265, Q58): whoever moves the tree (`app.execute`,
 * `app.resume`) holds it, so one instance at a time continues it. It carries its own key, so
 * `renew` and `release` need no lookup.
 */
export interface ExecutionLease {
  /** The tenant of the tree (`"default"` until tenants, #261). */
  readonly tenantId: string;
  /** The root execution of the tree (`executionContext.root.executionId`). */
  readonly rootExecutionId: string;
  /** The application instance that holds it. */
  readonly holderInstanceId: string;
  /**
   * The fence of the holder (#471: `executionContext.fence.token`): a counter of this one lease key
   * `(tenantId, rootExecutionId)` — 1 for its first holder, + 1 on every `acquire` after an expired
   * or released lease —, never a sequence across keys. Every implementation keeps it so (a
   * distributed store counts per key, not by its own revision).
   */
  readonly leaseEpoch: number;
  /** When the lease ends unless renewed (the framework's clock). */
  readonly expiresAt: Date;
  /**
   * The holder this `acquire` took the lease over from (#501): set only when the key's last lease
   * had expired without a release — its holder froze, died or was cut off —, never after a release
   * or for a first lease. Optional: a store that leaves it out still works; its takeovers name no
   * previous holder.
   */
  readonly takenOverFrom?: PreviousLeaseHolder;
}

/** Who held a lease that expired before another `acquire` took it over (#501). */
export interface PreviousLeaseHolder {
  readonly holderInstanceId: string;
  readonly leaseEpoch: number;
}

/** The previous holder of a stored lease that expired by `now` without a release (#501). */
export const takenOverFromOf = (
  stored: { readonly holderInstanceId: string; readonly leaseEpoch: number } | undefined,
  isExpired: boolean,
): { readonly takenOverFrom?: PreviousLeaseHolder } =>
  stored === undefined || !isExpired
    ? {}
    : {
        takenOverFrom: {
          holderInstanceId: stored.holderInstanceId,
          leaseEpoch: stored.leaseEpoch,
        },
      };

/**
 * Infrastructure (#265, Q58): one lease per execution tree, keyed by `(tenantId,
 * rootExecutionId)` — atomic and lease-based, so a lease expires by itself when its holder dies.
 * Listed only in `@Application({ providers })`; the built-in default is in memory. Your own
 * `extends ExecutionLeaseRepository`; time values come from the framework's clock, never from the
 * store.
 */
export abstract class ExecutionLeaseRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /** The tree's lease for `lease` from now; `undefined` while another holder's lease is valid. */
  abstract acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined>;

  /**
   * Extends the lease by `lease` from now; `false` when it was taken by another holder (after it
   * expired), and the caller must stop moving the tree.
   */
  abstract renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean>;

  /** Gives the lease up at once (the tree paused, finished or failed); another holder's is kept. */
  abstract release(executionLease: ExecutionLease): Promise<void>;

  /**
   * Marks the holder's lease yielded (#516): its holder waits for children on any instance and no
   * step of the tree runs. It is not a release — the lease stays the holder's: `acquire` of another
   * instance is refused while it is valid, `renew` keeps it (still yielded), and once it expired it
   * is taken over like a held one (`takenOverFrom`). `false` when the caller no longer holds it (as
   * for `renew`).
   */
  abstract yield(executionLease: ExecutionLease): Promise<boolean>;

  /**
   * The holder takes its lease back (#516: after a yield, before a step runs again) at
   * `leaseEpoch + 1`, held again for `lease` from now, with no `takenOverFrom`; `undefined` when it
   * is no longer the caller's (taken after it expired, or released) — the lease `renew` would keep.
   */
  abstract reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined>;
}

/** Whether `stored` is the very lease the caller holds (its holder and epoch). */
const isSameLease = (stored: ExecutionLease, held: ExecutionLease): boolean =>
  stored.leaseEpoch === held.leaseEpoch && stored.holderInstanceId === held.holderInstanceId;

/**
 * The built-in default: leases in this instance's memory — every operation is one synchronous
 * step, so it is atomic. With one instance nothing contends; the instances of one test share it. A
 * yielded lease is its row with `isYielded` (#516): read by nothing but the people looking at it.
 */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class InMemoryExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly database: InMemoryDatabase,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(tenantId, rootExecutionId);
    const now = this.clock.now();
    const stored = this.database.executionLeases.get(key);
    const held = stored !== undefined && !stored.released && stored.lease.expiresAt > now;
    if (held) return Promise.resolve(undefined);
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.applicationContext.instanceId,
      leaseEpoch: (stored?.lease.leaseEpoch ?? 0) + 1,
      expiresAt: new Date(now.getTime() + lease),
      // held is false here: a stored lease not released has expired
      ...takenOverFromOf(stored?.lease, stored?.released === false),
    };
    this.database.executionLeases.set(key, { lease: taken, released: false });
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.database.executionLeases.get(key);
    if (stored === undefined || stored.released || !isSameLease(stored.lease, executionLease)) {
      return Promise.resolve(false);
    }
    const expiresAt = new Date(this.clock.now().getTime() + lease);
    this.database.executionLeases.set(key, { ...stored, lease: { ...stored.lease, expiresAt } });
    return Promise.resolve(true);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.database.executionLeases.get(key);
    if (stored !== undefined && isSameLease(stored.lease, executionLease)) {
      this.database.executionLeases.set(key, { lease: stored.lease, released: true });
    }
    return Promise.resolve();
  }

  yield(executionLease: ExecutionLease): Promise<boolean> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored !== undefined)
      this.database.executionLeases.set(key, { ...stored, isYielded: true });
    return Promise.resolve(stored !== undefined);
  }

  reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored === undefined) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId } = stored.lease;
    const expiresAt = new Date(this.clock.now().getTime() + lease);
    const leaseEpoch = stored.lease.leaseEpoch + 1;
    const reclaimed = { tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt };
    this.database.executionLeases.set(key, { lease: reclaimed, released: false });
    return Promise.resolve(reclaimed);
  }

  /** The stored row of `key` while it is still `held` — as `renew` finds it; `undefined` otherwise. */
  #heldOf(key: string, held: ExecutionLease): ExecutionLeaseRow | undefined {
    const stored = this.database.executionLeases.get(key);
    const isHeld = stored !== undefined && !stored.released && isSameLease(stored.lease, held);
    return isHeld ? stored : undefined;
  }
}
