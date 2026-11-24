import { markBusinessKeyWriter } from "../components/container/fenced-reach.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";
import type { EffectKey } from "./fenced-effect.repository.js";
import { LeaseCheck } from "./execution-lease.repository.js";
import type { OutboundCallStatusQuery } from "./outbound-call-pages.js";
import type { Page } from "../app/page.js";
import type { OutboundCallLeaseState } from "./execution-audit-log.repository.js";
import type {
  OutboundCallClaim,
  OutboundCallLease,
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

export { OutboundCallStatus } from "./outbound-call-status.js";

export {
  DEFAULT_OUTBOUND_CALL_PAGE,
  MAX_OUTBOUND_CALL_PAGE,
  type OutboundCallPage,
  type OutboundCallStatusQuery,
} from "./outbound-call-pages.js";
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
 * zombie can neither read, record nor complete an intent: `ExecutionError.Fenced`, a hand-over.
 * Listed only in `@Application({ providers })`; the built-in default is in memory
 * (`InMemoryOutboundCallRepository`), `SqliteOutboundCallRepository` keeps them in the application's
 * SQLite file. A store reads the leases of the lease store of its database, so the two are listed
 * together.
 */
export abstract class OutboundCallRepository {
  /**
   * Where the store's rows live and how it checks the lease against its write (#526, #825): its
   * `backend` must be the application's lease store's — its write and the lease check are one
   * transaction (a unit runner holds its lease in the lease store of that backend). `backend`
   * undefined: undeclared, which fails assembly (`[application.store-backend-undeclared]`) unless the
   * store opts out with `leaseCheck: LeaseCheck.WithoutDoubleChargeProtection`, which names what is lost.
   */
  static readonly store: StoreDescriptor = { backend: undefined, leaseCheck: LeaseCheck.Atomic };

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** The intent of `key`, if one was recorded — fenced: a stale token is refused before the read. */
  abstract findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined>;

  /** Records `intent` `Pending` under `key` — fenced; `false` when the key has one already. */
  abstract saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean>;

  /**
   * The intent goes `Pending` at `claim` — the next attempt and its new owner (a resend after
   * `notSent()` or a failure) — only while it is still as `expected`: its status, attempt and
   * attempt owner as the caller read them. A compare-and-set in the fenced transaction, the
   * caller's lease checked first; `false` when another call moved it first (or it is gone): the
   * caller must not send.
   */
  abstract markPending(
    key: EffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean>;

  /**
   * The intent is `Completed` with `result` (its JSON) — fenced, and only while `attemptOwner` still
   * owns its attempt (a compare-and-set): `false` when a newer attempt took it over, nothing changed.
   * `expiresAt` is when the ended intent may be removed (`deleteExpired`); `null`: never
   * (`Ttl.Forever`). A pending intent has none.
   */
  abstract markCompleted(
    key: EffectKey,
    attemptOwner: string,
    result: string,
    expiresAt: Date | null,
  ): Promise<boolean>;

  /** The intent is `Failed` with `failure` — fenced, and only while `attemptOwner` owns it; `expiresAt` as `markCompleted`. */
  abstract markFailed(
    key: EffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
    expiresAt: Date | null,
  ): Promise<boolean>;

  /** Every call of one tree of a tenant, in the order recorded. */
  abstract findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]>;

  /**
   * A page of a tenant's calls in `status` (#825), in the store's record order (`Pending`: what waits
   * for reconciliation): at most `limit`, those after the cursor `after` (none → from the first), and
   * `next` — the cursor of the page's last call — when more may follow. Keyset paging on an immutable
   * order of the store's own, never an offset: a call in `status` for the whole read is listed
   * exactly once, whatever is recorded or leaves the status between pages; none is listed twice.
   * `after` is the store's own opaque text, given back as it was handed out.
   */
  abstract findAllByTenantIdAndStatus(
    query: OutboundCallStatusQuery,
  ): Promise<Page<OutboundCallRecord>>;

  /**
   * Removes the `Completed` and `Failed` intents whose `expiresAt` has come (`<= now`, the recovery
   * sweep, on the `Clock`); never a `Pending` one, nor one with no expiry (`Ttl.Forever`). The
   * number removed. An intent claimed for a new attempt has no expiry again until it ends.
   */
  abstract deleteExpired(now: Date): Promise<number>;

  /**
   * The state of `lease` — `(tenantId, leaseExecutionId)` at `token` (#508) —, in one atomic step:
   * `Live` — held at `token`, not expired: a pending attempt written under it on another instance is
   * in flight (its holder releases the lease only once its attempts settled, or stops renewing it
   * past their `attemptTimeout`, and never yields it under one); `Ended` — released, or its token
   * moved on: its owner is gone; `LeaseClosed` — expired at `token`, and closed by this check: released
   * at `token`, so its holder can neither renew it nor write under it again (what it sends late is
   * fenced) — marked closed by a check, not by its holder, so the next take of its tree is a takeover
   * from that holder at that token (`takenOverFrom`). A late renewal and this check never
   * both win: the lease is renewed and `Live`, or `LeaseClosed` and not renewable.
   */
  abstract leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState>;
}

// #825: a component that reaches the store itself writes under business keys as OutboundCalls does
markBusinessKeyWriter(OutboundCallRepository);
