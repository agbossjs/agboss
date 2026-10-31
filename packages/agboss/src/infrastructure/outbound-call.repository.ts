import type { Class } from "../components/injection.js";
import type { FencedEffectKey } from "./fenced-effect.repository.js";
import { Injectable } from "../components/decorators.js";
import { StoreClock, type Clock } from "./clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
  LeaseCheck,
} from "./execution-lease.repository.js";
import {
  checkInMemoryFence,
  inMemoryLeaseMismatch,
  raiseInMemoryMark,
} from "./in-memory-fenced-effect.repository.js";
import { fencedKeyIdentityOf, pendingOutboundCallOf } from "./fenced-effect-key.js";
import { IN_MEMORY_DATABASE } from "./in-memory-database.js";
import type { InMemoryDatabase } from "./in-memory-database.js";
import type { OutboundCallLeaseState } from "./execution-lease-event.repository.js";
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
 * Calls that leave the system (#505): before a step sends a request to another system (a payment
 * API, an email, a webhook), the framework records an **intent** — what is about to be sent, under
 * the step's idempotency key — in a fenced write; after the call it marks the intent completed with
 * the result, or failed with the error. An intent left pending (the process died before the answer)
 * is never sent again blindly: the component's `reconcile` asks the other system what happened.
 * Every intent is a record of a call that left the system (`app.outboundCallsOf`). Wiki →
 * Several-instances.
 */

/** Where an intent stands. */
export enum OutboundCallStatus {
  /** Recorded, and sent or about to be: what happened is not known here. */
  Pending = "pending",
  /** The other system answered: its result is stored. */
  Completed = "completed",
  /** The other system answered with an error: the next call sends it again, the same key. */
  Failed = "failed",
}

export type {
  OutboundCallClaim,
  OutboundCallLease,
  OutboundCallEnding,
  OutboundCallFailure,
  OutboundCallIntent,
  OutboundCallRecord,
  OutboundCallState,
  OutboundCallStep,
} from "./outbound-call-record.js";

/**
 * Infrastructure (#505): the intents of calls that leave the system, one per key. Every write and
 * the lookup by key are **fenced** like a fenced effect (#500) — in one transaction, the lease the
 * key names (its epoch, held, not expired) and the scope's high-water mark are checked first, so a
 * zombie can neither read, record nor complete an intent: `ExecutionFencedError`, a hand-over.
 * Listed only in `@Application({ providers })`; the built-in default is in memory
 * (`InMemoryOutboundCallRepository`), `SqliteOutboundCallRepository` keeps them in the application's
 * SQLite file. A store reads the leases of the lease store of its database, so the two are listed
 * together.
 */
export abstract class OutboundCallRepository {
  /**
   * The lease store whose leases the store checks — the one of its database: a unit runner holds
   * its lease there. Assembly checks `backend`, not this.
   */
  static readonly leaseRepository: Class | undefined = undefined;

  /**
   * The backend the store's rows live in (#526, as `ExecutionLeaseRepository.backend`): listed, it
   * must be the application's lease store's — its write and the lease check are one transaction.
   * Unset: undeclared, which fails assembly (`[application.store-backend-undeclared]`) unless the
   * store opts out with `leaseCheck`.
   */
  static readonly backend: string | undefined = undefined;

  /**
   * How the store checks the lease against its write (#526): `LeaseCheck.Atomic` (checked at
   * assembly), or the opt-out `LeaseCheck.WithoutDoubleChargeProtection`, which names what is lost.
   */
  static readonly leaseCheck: LeaseCheck = LeaseCheck.Atomic;

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** The intent of `key`, if one was recorded — fenced: a stale token is refused before the read. */
  abstract findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined>;

  /** Records `intent` `Pending` under `key` — fenced; `false` when the key has one already. */
  abstract saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean>;

  /**
   * The intent goes `Pending` at `claim` — the next attempt and its new owner (a resend after
   * `notSent()` or a failure) — only while it is still as `expected`: its status, attempt and
   * attempt owner as the caller read them. A compare-and-set in the fenced transaction, the
   * caller's lease checked first; `false` when another call moved it first (or it is gone): the
   * caller must not send.
   */
  abstract markPending(
    key: FencedEffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean>;

  /**
   * The intent is `Completed` with `result` (its JSON) — fenced, and only while `attemptOwner` still
   * owns its attempt (a compare-and-set): `false` when a newer attempt took it over, nothing changed.
   */
  abstract markCompleted(
    key: FencedEffectKey,
    attemptOwner: string,
    result: string,
  ): Promise<boolean>;

  /** The intent is `Failed` with `failure` — fenced, and only while `attemptOwner` owns it. */
  abstract markFailed(
    key: FencedEffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
  ): Promise<boolean>;

  /** Every call of one tree of a tenant, in the order recorded. */
  abstract findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]>;

  /** A tenant's calls in `status`, in the order recorded (`Pending`: what waits for reconciliation). */
  abstract findAllByTenantIdAndStatus(
    tenantId: string,
    status: OutboundCallStatus,
  ): Promise<readonly OutboundCallRecord[]>;

  /** Removes the `Completed` and `Failed` intents that ended before `cutoff`; never a `Pending` one. */
  abstract deleteByEndedAtBefore(cutoff: Date): Promise<void>;

  /**
   * The state of `lease` — `(tenantId, leaseExecutionId)` at `token` (#508) —, in one atomic step:
   * `Live` — held at `token`, not expired: a pending attempt written under it on another instance is
   * in flight (its holder releases the lease only once its attempts settled, or stops renewing it
   * past their `attemptTimeout`, and never yields it under one); `Ended` — released, or its token
   * moved on: its owner is gone; `Superseded` — expired at `token`, and closed by this check: released
   * at `token`, so its holder can neither renew it nor write under it again (what it sends late is
   * fenced) — marked closed by a check, not by its holder, so the next take of its tree is a takeover
   * from that holder at that token (`takenOverFrom`). A late renewal and this check never
   * both win: the lease is renewed and `Live`, or `Superseded` and not renewable.
   */
  abstract leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState>;
}

/**
 * The built-in default (#505): the intents in the instance's `InMemoryDatabase`, beside the
 * in-memory leases and the scopes' marks it checks — the instances of one test share them. Every
 * fenced method checks the key's lease and the scope's mark first, then raises the mark.
 */
@Injectable({ deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
export class InMemoryOutboundCallRepository extends OutboundCallRepository {
  static override readonly leaseRepository: Class | undefined = InMemoryExecutionLeaseRepository;
  static override readonly backend: string | undefined = "in-memory";

  constructor(
    private readonly clock: Pick<Clock, "now">,
    private readonly database: InMemoryDatabase,
    private readonly leases: ExecutionLeaseRepository,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, () => {
      const found = this.database.outboundCalls.get(fencedKeyIdentityOf(key));
      // Stryker disable next-line ConditionalExpression: `structuredClone(undefined)` is undefined
      return found === undefined ? undefined : structuredClone(found);
    });
  }

  saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      const row = fencedKeyIdentityOf(key);
      if (this.database.outboundCalls.has(row)) return false;
      this.database.outboundCalls.set(
        row,
        structuredClone(pendingOutboundCallOf(key, intent, this.clock.now())),
      );
      return true;
    });
  }

  markPending(
    key: FencedEffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    return this.#changed(key, (found) =>
      isInState(found, expected)
        ? { ...withoutEnd(found), status: OutboundCallStatus.Pending, ...claim }
        : undefined,
    );
  }

  markCompleted(key: FencedEffectKey, owner: string, result: string): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Completed, result });
  }

  markFailed(key: FencedEffectKey, owner: string, failure: OutboundCallFailure): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Failed, failure: { ...failure } });
  }

  /** The attempt of `attemptOwner` ended as `ending`, now: `false` when a newer one owns it. */
  #ended(key: FencedEffectKey, attemptOwner: string, ending: OutboundCallEnding): Promise<boolean> {
    const endedAt = this.clock.now().toISOString();
    return this.#changed(key, (found) => endedOf(found, attemptOwner, ending, endedAt));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where(
      (row) => row.tenantId === tenantId && row.rootExecutionId === rootExecutionId,
    );
  }

  findAllByTenantIdAndStatus(
    tenantId: string,
    status: OutboundCallStatus,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where((row) => row.tenantId === tenantId && row.status === status);
  }

  async leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    const { inMemoryLeaseStateOf } = await import("./live-lease.js");
    return inMemoryLeaseStateOf(this.database, lease, this.clock.now());
  }

  deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    const before = cutoff.getTime();
    for (const [row, found] of this.database.outboundCalls)
      // Stryker disable next-line ConditionalExpression: `Date.parse(undefined)` is NaN, and `NaN < before` is false
      if (found.endedAt !== undefined && Date.parse(found.endedAt) < before)
        this.database.outboundCalls.delete(row);
    return Promise.resolve();
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
    key: FencedEffectKey,
    change: (found: OutboundCallRecord) => OutboundCallRecord | undefined,
  ): Promise<boolean> {
    return this.#fenced(key, () => {
      const row = fencedKeyIdentityOf(key);
      const found = this.database.outboundCalls.get(row);
      const changed = found === undefined ? undefined : change(found);
      if (changed === undefined) return false;
      const owner = { token: key.token, leaseExecutionId: key.leaseExecutionId };
      this.database.outboundCalls.set(row, { ...changed, ...owner });
      return true;
    });
  }

  /** `work` after the fencing checks (the mark raised): one synchronous step, nothing in between. */
  #fenced<TValue>(key: FencedEffectKey, work: () => TValue): Promise<TValue> {
    const mismatch = inMemoryLeaseMismatch(this, this.leases);
    if (mismatch !== undefined) return Promise.reject(mismatch);
    return new Promise((resolve) => {
      checkInMemoryFence(this.database, this.clock, key);
      raiseInMemoryMark(this.database, this.clock, key);
      resolve(work());
    });
  }
}

/** Whether `found` is still as `expected`. */
export const isInState = (found: OutboundCallRecord, expected: OutboundCallState): boolean =>
  found.status === expected.status &&
  found.attempt === expected.attempt &&
  found.attemptOwner === expected.attemptOwner;

/** A record without its last ending (`result`, `failure`, `endedAt`): sent again, or ending now. */
export function withoutEnd(found: OutboundCallRecord): OutboundCallRecord {
  const record = { ...found };
  delete record.result;
  delete record.failure;
  delete record.endedAt;
  return record;
}

/** `found` ended as `ending` at `endedAt` — only while it is pending and `attemptOwner` owns it. */
export const endedOf = (
  found: OutboundCallRecord,
  attemptOwner: string,
  ending: OutboundCallEnding,
  endedAt: string,
): OutboundCallRecord | undefined =>
  found.attemptOwner === attemptOwner && found.status === OutboundCallStatus.Pending
    ? { ...withoutEnd(found), ...ending, endedAt }
    : undefined;
