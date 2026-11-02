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
  type ExecutionIdentity,
  type ExecutionLease,
} from "../../../src/index.js";
import type { Milliseconds } from "../../../src/units/index.js";

/** The backing store: the leases by tree. */
export class LeaseTable {
  readonly rows = new Map<string, ExecutionLease>();
  /** The trees whose last lease was released, not left to expire (#501: no previous holder). */
  readonly released = new Set<string>();
  /** The trees whose lease its holder yielded (#516): still its own. */
  readonly yielded = new Set<string>();
  /** The trees whose lease its holder finished (#520): never taken again. */
  readonly finished = new Set<string>();
  /** Every execution id handed out (#591), by the id alone. */
  readonly executionIds = new Set<string>();
}

const keyOf = (tenantId: string, rootExecutionId: string): string =>
  JSON.stringify([tenantId, rootExecutionId]);

const isSameLease = (stored: ExecutionLease | undefined, held: ExecutionLease): boolean =>
  stored?.leaseEpoch === held.leaseEpoch && stored.holderInstanceId === held.holderInstanceId;

export class MapExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly table: LeaseTable,
    private readonly clock: Pick<Clock, "now">,
    private readonly application: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** The backing store's ids (#591): what a broken subclass reads and writes in steps. */
  protected get executionIds(): Set<string> {
    return this.table.executionIds;
  }

  saveExecutionIdIfAbsent({ executionId }: ExecutionIdentity): Promise<boolean> {
    if (this.executionIds.has(executionId)) return Promise.resolve(false);
    this.executionIds.add(executionId);
    return Promise.resolve(true);
  }

  /** The time, in milliseconds: the store's clock (#533: `seam.storeClock`). */
  protected now(): number {
    return this.clock.now().getTime();
  }

  /** Whether `stored` still holds its tree now. */
  protected isValid(stored: ExecutionLease | undefined): boolean {
    return stored !== undefined && stored.expiresAt.getTime() > this.now();
  }

  /** Whether a take of the tree would find its lease free now (#695: what a broken take checks). */
  protected isFreeNow(tenantId: string, rootExecutionId: string): boolean {
    const key = keyOf(tenantId, rootExecutionId);
    return !this.isValid(this.table.rows.get(key)) && !this.table.finished.has(key);
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = keyOf(tenantId, rootExecutionId);
    const stored = this.table.rows.get(key);
    if (this.isValid(stored) || this.table.finished.has(key)) return Promise.resolve(undefined);
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.application.instanceId,
      leaseEpoch: (stored?.leaseEpoch ?? 0) + 1,
      expiresAt: new Date(this.now() + lease),
      remaining: lease,
      ...(stored === undefined || this.table.released.has(key)
        ? {}
        : {
            takenOverFrom: {
              holderInstanceId: stored.holderInstanceId,
              leaseEpoch: stored.leaseEpoch,
            },
          }),
    };
    this.table.rows.set(key, taken);
    this.table.released.delete(key);
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<Milliseconds | undefined> {
    const key = this.#heldKeyOf(executionLease);
    if (key === undefined) return Promise.resolve(undefined);
    this.table.rows.set(key, { ...executionLease, expiresAt: new Date(this.now() + lease) });
    return Promise.resolve(lease);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    const key = keyOf(executionLease.tenantId, executionLease.rootExecutionId);
    if (isSameLease(this.table.rows.get(key), executionLease)) {
      // kept, expired now: the next holder's epoch counts on from it
      this.table.rows.set(key, { ...executionLease, expiresAt: new Date(this.now()) });
      this.table.released.add(key);
    }
    return Promise.resolve();
  }

  finish(executionLease: ExecutionLease): Promise<void> {
    const key = keyOf(executionLease.tenantId, executionLease.rootExecutionId);
    // in one step with the release: an acquire in between would take the finished key
    if (isSameLease(this.table.rows.get(key), executionLease)) this.table.finished.add(key);
    return this.release(executionLease);
  }

  yield(executionLease: ExecutionLease): Promise<boolean> {
    const key = this.#heldKeyOf(executionLease);
    if (key !== undefined) this.table.yielded.add(key);
    return Promise.resolve(key !== undefined);
  }

  reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = this.#heldKeyOf(executionLease);
    if (key === undefined) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId } = executionLease;
    const leaseEpoch = executionLease.leaseEpoch + 1;
    const expiresAt = new Date(this.now() + lease);
    const reclaimed = {
      ...{ tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt },
      remaining: lease,
    };
    this.table.rows.set(key, reclaimed);
    this.table.yielded.delete(key);
    return Promise.resolve(reclaimed);
  }

  /**
   * The key of `executionLease` while it is still its holder's: not taken, not released, not
   * expired (#534: at `expiresAt` it is over for its holder too).
   */
  #heldKeyOf(executionLease: ExecutionLease): string | undefined {
    const key = keyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.table.rows.get(key);
    const isHeld =
      isSameLease(stored, executionLease) && !this.table.released.has(key) && this.isValid(stored);
    return isHeld ? key : undefined;
  }
}
