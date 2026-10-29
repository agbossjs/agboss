/**
 * A lease store as a store author outside the core writes one (#481): built only from the public
 * entries — the contract, its types, the framework's clock and the instance's context. Its rows
 * live in a `LeaseTable` both instances of a test share (its "backing store"). The broken stores
 * of the AC2 fixtures are subclasses of it.
 */
import {
  ExecutionLeaseRepository,
  type ApplicationContext,
  type Clock,
  type ExecutionLease,
} from "../../../src/index.js";
import type { Milliseconds } from "../../../src/units/index.js";

/** The backing store: the leases by tree. */
export class LeaseTable {
  readonly rows = new Map<string, ExecutionLease>();
}

const keyOf = (tenantId: string, rootExecutionId: string): string =>
  JSON.stringify([tenantId, rootExecutionId]);

const isSameLease = (stored: ExecutionLease | undefined, held: ExecutionLease): boolean =>
  stored?.leaseEpoch === held.leaseEpoch && stored.holderInstanceId === held.holderInstanceId;

export class MapExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly table: LeaseTable,
    private readonly clock: Clock,
    private readonly application: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** The time, in milliseconds: the framework's clock. */
  protected now(): number {
    return this.clock.now().getTime();
  }

  /** Whether `stored` still holds its tree now. */
  protected isValid(stored: ExecutionLease | undefined): boolean {
    return stored !== undefined && stored.expiresAt.getTime() > this.now();
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = keyOf(tenantId, rootExecutionId);
    const stored = this.table.rows.get(key);
    if (this.isValid(stored)) return Promise.resolve(undefined);
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.application.instanceId,
      leaseEpoch: (stored?.leaseEpoch ?? 0) + 1,
      expiresAt: new Date(this.now() + lease),
    };
    this.table.rows.set(key, taken);
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    const key = keyOf(executionLease.tenantId, executionLease.rootExecutionId);
    if (!isSameLease(this.table.rows.get(key), executionLease)) return Promise.resolve(false);
    this.table.rows.set(key, { ...executionLease, expiresAt: new Date(this.now() + lease) });
    return Promise.resolve(true);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    const key = keyOf(executionLease.tenantId, executionLease.rootExecutionId);
    if (isSameLease(this.table.rows.get(key), executionLease)) {
      // kept, expired now: the next holder's epoch counts on from it
      this.table.rows.set(key, { ...executionLease, expiresAt: new Date(this.now()) });
    }
    return Promise.resolve();
  }
}
