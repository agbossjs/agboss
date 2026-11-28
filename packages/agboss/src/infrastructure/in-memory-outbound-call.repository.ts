import type { StoreDescriptor } from "./execution-lease.repository.js";
import type { EffectKey } from "./fenced-effect.repository.js";
import { Injectable } from "../components/decorators.js";
import { OutboundCallStatus } from "./outbound-call-status.js";
import { OutboundCallRepository } from "./outbound-call.repository.js";
import { StoreClock, lazyLoad } from "./clock.js";
import { ExecutionLeaseRepository } from "./execution-lease.repository.js";
import {
  checkInMemoryFence,
  inMemoryLeaseMismatch,
  raiseInMemoryMark,
} from "./in-memory-fenced-effect.repository.js";
import {
  effectKeyIdentityOf,
  pendingOutboundCallOf,
  previousIdentityOf,
} from "./fenced-effect-key.js";
import {
  inMemoryPageOf,
  nextPlaceIn,
  type OutboundCallStatusQuery,
} from "./outbound-call-pages.js";
import type { Page } from "../app/page.js";
import {
  checkInMemoryCancel,
  IN_MEMORY_DATABASE,
  prunedCallsAt,
  type InMemoryDatabase,
} from "./in-memory-database.js";
import type { OutboundCallLeaseState } from "./execution-audit-log.repository.js";
import type {
  OutboundCallClaim,
  OutboundCallLease,
  OutboundCallEnding,
  OutboundCallFailure,
  OutboundCallIntent,
  OutboundCallRecord,
  OutboundCallState,
} from "./outbound-call-record.js";

/**
 * The built-in default (#505): the intents in the instance's `InMemoryDatabase`, beside the
 * in-memory leases and the scopes' marks it checks — the instances of one test share them. Every
 * fenced method checks the key's lease and the scope's mark first, then raises the mark.
 */
@Injectable({ deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
export class InMemoryOutboundCallRepository extends OutboundCallRepository {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  /**
   * @internal The container injects the instance's in-memory database: left out of the declarations.
   */
  constructor(
    private readonly clock: Pick<StoreClock, "now">,
    private readonly database: InMemoryDatabase,
    private readonly leases: ExecutionLeaseRepository,
  ) {
    super();
  }

  /**
   * How it changes an intent (#658), loaded when the store is made, not with the root import (its
   * module budget): long loaded by the first change.
   */
  readonly #changes = lazyLoad(import("./outbound-call-changes.js"));

  /** The store's time as a record keeps it (#658: when a read by key read). */
  #now(): string {
    return this.clock.now().toISOString();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, () => {
      const found = this.database.outboundCalls.get(this.#rowOf(key));
      // a copy of the row, read now (#658)
      return found === undefined ? undefined : { ...structuredClone(found), readAt: this.#now() };
    });
  }

  saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      checkInMemoryCancel(this.database, key); // #909: a new intent is a new send
      const row = this.#rowOf(key);
      if (this.database.outboundCalls.has(row)) return false;
      this.database.outboundCalls.set(
        row,
        structuredClone(pendingOutboundCallOf(key, intent, this.clock.now())),
      );
      // its place in the record order (#825): after every intent recorded before it, never reused
      this.database.outboundCallOrder.set(row, nextPlaceIn(this.database));
      return true;
    });
  }

  async markPending(
    key: EffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    const { claimedOf } = await this.#changes;
    const startedAt = this.clock.now();
    // #909: a new attempt is a new send, refused after the tree's cancel
    return this.#changed(key, (found) => claimedOf(found, expected, claim, startedAt), true);
  }

  markCompleted(
    key: EffectKey,
    attemptOwner: string,
    result: string,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const ending = { status: OutboundCallStatus.Completed, result } as const;
    return this.#ended(key, attemptOwner, ending, expiresAt);
  }

  markFailed(
    key: EffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const ending = { status: OutboundCallStatus.Failed, failure: { ...failure } } as const;
    return this.#ended(key, attemptOwner, ending, expiresAt);
  }

  /** The attempt of `attemptOwner` ended as `ending`, now: `false` when a newer one owns it. */
  async #ended(
    key: EffectKey,
    attemptOwner: string,
    ending: OutboundCallEnding,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const { endedOf } = await this.#changes;
    const endedAt = this.clock.now().toISOString();
    return this.#changed(
      key,
      (found) => endedOf(found, attemptOwner, ending, endedAt),
      false,
      expiresAt?.getTime() ?? null,
    );
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where(
      (row) => row.tenantId === tenantId && row.rootExecutionId === rootExecutionId,
    );
  }

  findAllByTenantIdAndStatus(query: OutboundCallStatusQuery): Promise<Page<OutboundCallRecord>> {
    return inMemoryPageOf(this.database, query);
  }

  async leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    const { inMemoryLeaseStateOf } = await lazyLoad(import("./live-lease.js"));
    return inMemoryLeaseStateOf(this.database, lease, this.clock.now());
  }

  deleteExpired(now: Date): Promise<number> {
    return Promise.resolve(prunedCallsAt(this.database, now.getTime()));
  }

  /**
   * The row of the key's intent: its own — or, after a rotation of the idempotency secret, the one
   * written under the previous digest of its business key; a new intent is written under the key's.
   */
  #rowOf(key: EffectKey): string {
    const row = effectKeyIdentityOf(key);
    const previous = previousIdentityOf(key);
    if (previous === undefined || this.database.outboundCalls.has(row)) return row;
    const earlier = effectKeyIdentityOf(previous);
    return this.database.outboundCalls.has(earlier) ? earlier : row;
  }

  /** The rows that match, in the order recorded, as copies. */
  #where(matches: (row: OutboundCallRecord) => boolean): Promise<readonly OutboundCallRecord[]> {
    const found = [...this.database.outboundCalls.values()].filter(matches);
    return Promise.resolve(found.map((row) => structuredClone(row)));
  }

  /**
   * A fenced change of the key's intent, written under the key's lease and token; none recorded, or
   * `change` declines (`undefined`) → nothing, `false`.
   */
  #changed(
    key: EffectKey,
    change: (found: OutboundCallRecord) => OutboundCallRecord | undefined,
    isSend: boolean,
    expiresAt?: number | null,
  ): Promise<boolean> {
    return this.#fenced(key, () => {
      if (isSend) checkInMemoryCancel(this.database, key);
      const row = this.#rowOf(key);
      const found = this.database.outboundCalls.get(row);
      const changed = found === undefined ? undefined : change(found);
      if (changed === undefined) return false;
      const owner = { token: key.token, leaseExecutionId: key.leaseExecutionId };
      this.database.outboundCalls.set(row, { ...changed, ...owner });
      // an ended intent has an expiry (`null`: never); a claimed one — pending again — none
      if (expiresAt === undefined) this.database.outboundCallExpiries.delete(row);
      else this.database.outboundCallExpiries.set(row, expiresAt);
      return true;
    });
  }

  /** `work` after the fencing checks (the mark raised): one synchronous step, nothing in between. */
  #fenced<TValue>(key: EffectKey, work: () => TValue): Promise<TValue> {
    const mismatch = inMemoryLeaseMismatch(this, this.leases);
    if (mismatch !== undefined) return Promise.reject(mismatch);
    return new Promise((resolve) => {
      checkInMemoryFence(this.database, this.clock, key);
      raiseInMemoryMark(this.database, this.clock, key);
      resolve(work());
    });
  }
}
