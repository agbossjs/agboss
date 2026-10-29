import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock } from "./clock.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

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
}

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
}

/** Whether `stored` is the very lease the caller holds (its holder and epoch). */
const isSameLease = (stored: ExecutionLease, held: ExecutionLease): boolean =>
  stored.leaseEpoch === held.leaseEpoch && stored.holderInstanceId === held.holderInstanceId;

/**
 * The built-in default: leases in this instance's memory — every operation is one synchronous
 * step, so it is atomic. With one instance nothing contends; the instances of one test share it.
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
    this.database.executionLeases.set(key, {
      lease: { ...stored.lease, expiresAt },
      released: false,
    });
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
}
