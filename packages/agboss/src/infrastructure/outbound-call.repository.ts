import type { Class } from "../components/injection.js";
import type { FencedEffectKey } from "./fenced-effect.repository.js";
import { Injectable } from "../components/decorators.js";
import { Clock } from "./clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "./execution-lease.repository.js";
import {
  checkInMemoryFence,
  inMemoryLeaseMismatch,
  raiseInMemoryMark,
} from "./in-memory-fenced-effect.repository.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import type { InMemoryDatabase } from "./in-memory-database.js";
import type {
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
   * The lease store whose leases the store checks — the one of its database: listed beside another,
   * the application fails assembly with `[application.fenced-effect-lease-store]`. Unset: not checked.
   */
  static readonly leaseRepository: Class | undefined = undefined;

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** The intent of `key`, if one was recorded — fenced: a stale token is refused before the read. */
  abstract findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined>;

  /** Records `intent` `Pending` under `key` — fenced; `false` when the key has one already. */
  abstract saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean>;

  /**
   * The intent goes `Pending` for `attempt` (a resend after `notSent()` or a failure) only while it
   * is still as `expected` — its status, attempt and token as the caller read them: a
   * compare-and-set in the fenced transaction, the caller's lease checked first. `false` when
   * another call moved it first (or it is gone): the caller must not send.
   */
  abstract markPending(
    key: FencedEffectKey,
    expected: OutboundCallState,
    attempt: number,
  ): Promise<boolean>;

  /** The intent is `Completed` with `result` (its JSON) — fenced. */
  abstract markCompleted(key: FencedEffectKey, result: string): Promise<void>;

  /** The intent is `Failed` with `failure` — fenced. */
  abstract markFailed(key: FencedEffectKey, failure: OutboundCallFailure): Promise<void>;

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
}

/** The row of a key: its scope, the step's idempotency key and the call's name. */
const rowKeyOf = (key: FencedEffectKey): string =>
  [key.scopeKey, key.idempotencyKey, key.name].join("\u0000");

/**
 * The built-in default (#505): the intents in the instance's `InMemoryDatabase`, beside the
 * in-memory leases and the scopes' marks it checks — the instances of one test share them. Every
 * fenced method checks the key's lease and the scope's mark first, then raises the mark.
 */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
export class InMemoryOutboundCallRepository extends OutboundCallRepository {
  static override readonly leaseRepository: Class | undefined = InMemoryExecutionLeaseRepository;

  constructor(
    private readonly clock: Clock,
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
      const found = this.database.outboundCalls.get(rowKeyOf(key));
      return found === undefined ? undefined : structuredClone(found);
    });
  }

  saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      const row = rowKeyOf(key);
      if (this.database.outboundCalls.has(row)) return false;
      this.database.outboundCalls.set(row, {
        ...structuredClone(intent),
        tenantId: key.tenantId,
        name: key.name,
        status: OutboundCallStatus.Pending,
        token: key.token,
        recordedAt: this.clock.now().toISOString(),
      });
      return true;
    });
  }

  markPending(
    key: FencedEffectKey,
    expected: OutboundCallState,
    attempt: number,
  ): Promise<boolean> {
    return this.#fenced(key, () => {
      const row = rowKeyOf(key);
      const found = this.database.outboundCalls.get(row);
      if (found === undefined || !isInState(found, expected)) return false;
      const moved = { ...withoutEnd(found), status: OutboundCallStatus.Pending, attempt };
      this.database.outboundCalls.set(row, { ...moved, token: key.token });
      return true;
    });
  }

  markCompleted(key: FencedEffectKey, result: string): Promise<void> {
    return this.#update(key, (found) => ({
      ...withoutEnd(found),
      status: OutboundCallStatus.Completed,
      result,
      endedAt: this.clock.now().toISOString(),
    }));
  }

  markFailed(key: FencedEffectKey, failure: OutboundCallFailure): Promise<void> {
    return this.#update(key, (found) => ({
      ...withoutEnd(found),
      status: OutboundCallStatus.Failed,
      failure: { ...failure },
      endedAt: this.clock.now().toISOString(),
    }));
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

  deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    const before = cutoff.getTime();
    for (const [row, found] of this.database.outboundCalls)
      if (found.endedAt !== undefined && Date.parse(found.endedAt) < before)
        this.database.outboundCalls.delete(row);
    return Promise.resolve();
  }

  /** The rows that match, in the order recorded, as copies. */
  #where(matches: (row: OutboundCallRecord) => boolean): Promise<readonly OutboundCallRecord[]> {
    const found = [...this.database.outboundCalls.values()].filter(matches);
    return Promise.resolve(found.map((row) => structuredClone(row)));
  }

  /** A fenced change of the key's intent, written under the key's token; none recorded → nothing. */
  #update(
    key: FencedEffectKey,
    change: (found: OutboundCallRecord) => OutboundCallRecord,
  ): Promise<void> {
    return this.#fenced(key, () => {
      const row = rowKeyOf(key);
      const found = this.database.outboundCalls.get(row);
      if (found !== undefined)
        this.database.outboundCalls.set(row, { ...change(found), token: key.token });
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

/** The state `markPending` expects of `found`: as it was read. */
export const stateOf = (found: OutboundCallRecord): OutboundCallState => ({
  status: found.status,
  attempt: found.attempt,
  token: found.token,
});

/** Whether `found` is still as `expected`. */
export const isInState = (found: OutboundCallRecord, expected: OutboundCallState): boolean =>
  found.status === expected.status &&
  found.attempt === expected.attempt &&
  found.token === expected.token;

/** A record without its last ending (`result`, `failure`, `endedAt`): sent again, or ending now. */
export const withoutEnd = (found: OutboundCallRecord): OutboundCallRecord => ({
  tenantId: found.tenantId,
  rootExecutionId: found.rootExecutionId,
  executionId: found.executionId,
  workflow: found.workflow,
  name: found.name,
  target: found.target,
  operation: found.operation,
  idempotencyKey: found.idempotencyKey,
  request: found.request,
  attempt: found.attempt,
  step: found.step,
  status: found.status,
  token: found.token,
  recordedAt: found.recordedAt,
});
