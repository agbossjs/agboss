import type { Milliseconds } from "../units/index.js";
import type { InterruptMode } from "../app/interrupt-types.js";
import type { NewStatusTransition } from "../turns/index.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { waitOf } from "./clock.js";

export { optsOutOfLeaseCheck, storeDescriptorOf } from "./store-descriptor.js";

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
  readonly token: number;
  /**
   * When the lease ends unless renewed, on the store's clock (#533: the database's for a networked
   * store) — information only: no instance compares it with its own clock.
   */
  readonly expiresAt: Date;
  /**
   * How long the lease stays live after the store's own instant of this take (#533): `expiresAt −
   * now`, both on the store's clock (`remainingOf`). The holder trusts it for `remaining` minus a
   * safety margin from the moment it sent the request, on its monotonic clock — never its wall clock.
   */
  readonly remaining: Milliseconds;
  /**
   * The holder this `acquire` took the lease over from (#501): set only when the key's last lease
   * had expired without a release — its holder froze, died or was cut off —, never after a release
   * or for a first lease. Optional: a store that leaves it out still works; its takeovers name no
   * previous holder.
   */
  readonly takenOverFrom?: PreviousLeaseHolder;
}

/**
 * An execution's identity (#591): its id, made once by the application's `IdGenerator`, and the
 * tenant it was made for. Unique by `executionId` alone, across tenants: the steps' idempotency
 * keys (`<executionId>:<nodeId>:<visit>`) and the key an outbound call sends with no business key
 * carry no tenant.
 */
export interface ExecutionIdentity {
  /** The id: a root's, a child's or a recursion level's. */
  readonly executionId: string;
  /** The tenant it was made for (kept, never part of the key). */
  readonly tenantId: string;
}

/** Who held a lease that expired before another `acquire` took it over (#501). */
export interface PreviousLeaseHolder {
  readonly holderInstanceId: string;
  readonly token: number;
}

/** The previous holder of a stored lease that expired by `now` without a release (#501). */
export const takenOverFromOf = (
  stored: { readonly holderInstanceId: string; readonly token: number } | undefined,
  isExpired: boolean,
): { readonly takenOverFrom?: PreviousLeaseHolder } =>
  stored === undefined || !isExpired
    ? {}
    : {
        takenOverFrom: {
          holderInstanceId: stored.holderInstanceId,
          token: stored.token,
        },
      };

/**
 * The time a lease ending at `expiresAt` has left at `now` (#533), both on the store's clock: whole
 * milliseconds rounded down — a store never overstates it — and never below 0.
 */
export const remainingOf = (expiresAt: Date, now: Date): Milliseconds =>
  waitOf(Math.floor(expiresAt.getTime() - now.getTime()));

/**
 * How a fenced-effect or an outbound-call store checks the lease against its write (#526):
 * `leaseCheck` of the store.s `static store`.
 */
export enum LeaseCheck {
  /**
   * In the write's own transaction, on the lease store's backend (the default): assembly checks the
   * store and the application's lease store declare one `backend`.
   */
  Atomic = "atomic",
  /**
   * The explicit opt-out: the lease is read outside the write's transaction, maybe on another
   * backend — so a holder whose lease was just taken over can still write. **No protection against
   * a double charge or a second owner's write.** Not checked at assembly; the start warns
   * `[application.lease-check-not-atomic]` (an error under `agboss check --strict`).
   */
  WithoutDoubleChargeProtection = "without-double-charge-protection",
}

/**
 * What a store class declares about its rows (#526, #825: `static store`, one descriptor in place of
 * separate statics) — read by assembly, `storeConformance` and the unit runners.
 */
export interface StoreDescriptor {
  /**
   * The backend the store's rows live in: `"<kind>"` or `"<kind>:<database>"` — `"postgres"`,
   * `"postgres:billing"` for a second database of one kind. Two stores share one transactional
   * backend exactly when they declare the same text: a listed fenced-effect or outbound-call store
   * checks the lease in its own transaction, so its `backend` must be its lease store's
   * (`[application.store-backend-mismatch]`, `[application.store-backend-undeclared]`); a unit
   * runner holds its lease in the lease store of that backend. `undefined`: undeclared.
   */
  readonly backend: string | undefined;
  /**
   * How a fenced-effect or an outbound-call store checks the lease against its write: `Atomic` (the
   * default when absent, checked at assembly) or the opt-out `WithoutDoubleChargeProtection`, which
   * names what is lost. A lease store has no lease to check: it leaves it out.
   */
  readonly leaseCheck?: LeaseCheck;
}

/**
 * Infrastructure (#265, Q58): one lease per execution tree, keyed by `(tenantId,
 * rootExecutionId)` — atomic and lease-based, so a lease expires by itself when its holder dies.
 * Listed only in `@Application({ providers })`; the built-in default is in memory. Your own
 * `extends ExecutionLeaseRepository`. The store decides expiry by its own time (#533, `StoreClock`:
 * a networked store's database clock, inside each statement; in-memory and SQLite the host's) and
 * answers the time left (`remaining`), never an instant a holder would compare with its own clock.
 */
export abstract class ExecutionLeaseRepository {
  /**
   * Where the store's rows live (#526, #825): `{ backend }` — `"postgres"`, `"postgres:billing"`;
   * a fenced-effect or outbound-call store on the same backend checks its leases in its own
   * transaction. `{ backend: undefined }`: undeclared.
   */
  static readonly store: StoreDescriptor = { backend: undefined };

  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;

  /**
   * Claims a new execution's identity (#591) — a root, a child or a recursion level — before
   * anything else of it is written: `true` when no execution ever had `executionId`, under any
   * tenant, and the id is now taken; `false` when it was taken before — a refusal, nothing written.
   * One atomic insert-if-absent: of concurrent claims of one id, on any instances, exactly one gets
   * `true`. Never removed — a finished, failed or cancelled execution's id is never handed out
   * again — and independent of the leases: `acquire` of an existing tree (a resume, a recovery)
   * never asks it.
   */
  abstract claimExecutionId(identity: ExecutionIdentity): Promise<boolean>;

  /**
   * The tree's lease for `duration` from now; `undefined` while another holder's lease is valid,
   * and for good once its holder retired it (`retire`, #520).
   */
  abstract acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined>;

  /**
   * Extends the lease by `duration` from now and answers the time it has left (#533: `remaining`,
   * on the store's clock — never shorter than before); `undefined` once it is over — expired (`now
   * >= expiresAt`, #534: the instant of expiry belongs to the next taker, the holder included),
   * taken by another holder, or released — and the caller must stop moving the tree.
   */
  abstract renew(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<Milliseconds | undefined>;

  /** Gives the lease up at once (the tree paused, finished or failed); another holder's is kept. */
  abstract release(executionLease: ExecutionLease): Promise<void>;

  /**
   * Gives the lease up for good (#520): the work under it is over — an `AnyWorker` child that
   * answered or failed — so no later `acquire` of its key gets a lease, whoever asks and whenever,
   * and no takeover of finished work can follow. One atomic step, matched as `release` matches
   * (another holder's lease is kept, nothing retired); a retired lease is renewed, yielded and
   * reclaimed no more.
   */
  abstract retire(executionLease: ExecutionLease): Promise<void>;

  /**
   * Marks the holder's lease yielded (#516): its holder waits for children on any instance and no
   * step of the tree runs. It is not a release — the lease stays the holder's: `acquire` of another
   * instance is refused while it is valid, `renew` keeps it (still yielded), and once it expired it
   * is taken over like a held one (`takenOverFrom`). Answers as `renew` does: the time the lease
   * has left (`remaining`, on the store's clock — not extended: a yield is no renewal); `undefined`
   * when the caller no longer holds it (expired at `now >= expiresAt` too, #534).
   */
  abstract yield(executionLease: ExecutionLease): Promise<Milliseconds | undefined>;

  /**
   * The holder takes its lease back (#516: after a yield, before a step runs again) at `token + 1`,
   * held again for `duration` from now, with no `takenOverFrom`; `undefined` when it is no longer
   * the caller's (expired at `now >= expiresAt`, #534 — taken or not —, or released) — the lease
   * `renew` would keep. An expired holder `acquire`s again: a takeover from itself. While an
   * `Immediate` external pause is set (#1341c), the reclaimed token inherits the fence **in the same
   * atomic step**: `fencedThroughToken` becomes `GREATEST(itself, token + 1)`, so the holder's first
   * write on it — and every child's, checked against the root's row — is refused as the fenced token
   * was, and the holder parks. A cancel or stop mark needs no such step: it fences by the row, not by
   * the token.
   */
  abstract reclaim(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined>;

  /**
   * Marks the tree's cancel as requested (#909): durable once this resolves, idempotent, and
   * permanent (#1117) — no retention pass, release, retire, take or takeover lifts it, as no lease
   * row and no execution id is ever removed. From then on every fencing store of this backend
   * refuses a new effect of the tree (not a replay, not an undo's) — the root's and every child's,
   * live or taken later — in the transaction that checks the lease. The mark lives on the tree's
   * own lease row, keyed by the tree's root (never by a child's lease): a cancel before the tree's
   * first `acquire` writes a seed row (token 0, released, never held), so that acquire is token 1
   * and no takeover. Changes no lease: the holder keeps it, renews it, runs the tree's undo under it.
   * With a `transition` (#1341d) the thread's status-history row is written **in the same
   * transaction as the mark** — on the same backend, so a crash between them is impossible — and
   * only when this call set the mark: a repeat writes none.
   */
  abstract requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void>;

  /**
   * Whether the tree's cancel mark is set (#1152): read from its own lease row (permanent, #1117),
   * `false` for a tree never asked. Changes nothing, takes no lease; the sweep reads it.
   */
  abstract isCancelRequested(tree: ExecutionTree): Promise<boolean>;

  /**
   * Marks the tree's stop as requested (#1341b, `app.stop`): durable once this resolves, idempotent
   * and permanent like the cancel mark, on the tree's own lease row (a seed row before its first
   * `acquire`), changing no lease. `mode` only escalates — `AfterStep` becomes `Immediate`, never
   * back. From then on, when the mode is `Immediate` and no cancel is marked, every fencing store of
   * this backend refuses a new effect of the tree (an undo's too: a stop has none) with
   * `ExecutionStopFencedError`; an `AfterStep` stop fences nothing — the step in flight commits. With
   * a `transition` the thread's status-history row is written in the mark's own transaction, only
   * when this call set or escalated the mark.
   */
  abstract requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void>;

  /** The tree's stop mark (#1341b), read from its own lease row; `undefined` for a tree never stopped. */
  abstract stopOf(tree: ExecutionTree): Promise<StopMark | undefined>;

  /**
   * Marks the tree as paused from outside (#1341c, `app.pause`): `isExternallyPaused` and its
   * `reason` on the tree's own lease row (a seed row before the first `acquire`), durable once this
   * resolves, idempotent — a repeat only updates the reason —, changing no lease. With
   * `InterruptMode.Immediate` the row's `fencedThroughToken` becomes `GREATEST(itself, the row's
   * current token)`: from then on a write of the tree's root lease at that token or below is refused
   * with `ExecutionError.Fenced`, in the transaction that checks the lease — a stale step in flight
   * is fenced, a lease taken at `token + 1` by `acquire` (an unpause, a cancel's unwind) is not — a
   * `reclaim` while the pause is set inherits the fence (see `reclaim`). The fence only
   * ever rises and is never cleared on the same token. The thread's history row is written in the
   * same transaction, only when this call set the mark.
   */
  abstract requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void>;

  /**
   * Lifts the tree's external pause (#1341c, `app.unpause`): `isExternallyPaused` is cleared, its
   * reason with it; `fencedThroughToken` stays — it is lifted only by a lease at a higher token. A
   * tree not paused from outside is a no-op, no history row either.
   */
  abstract unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void>;

  /** The tree's external pause and its fence (#1341c), from its own lease row. */
  abstract pauseOf(tree: ExecutionTree): Promise<PauseMarks>;

  /**
   * Both marks of the tree's lease row in one read (#1341b): what a take of the lease asks, so a
   * stop costs no round trip more than the cancel alone did. The default asks `isCancelRequested`
   * and `stopOf` together; a store that answers both from its one row overrides it.
   */
  async markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    const [isCancelRequested, stop, paused] = await Promise.all([
      this.isCancelRequested(tree),
      this.stopOf(tree),
      this.pauseOf(tree),
    ]);
    return { isCancelRequested, ...(stop === undefined ? {} : { stop }), ...paused };
  }
}

/** What a tree's lease row carries: its cancel mark, and its stop mark when it has one. */
export interface TreeMarks extends PauseMarks {
  readonly isCancelRequested: boolean;
  readonly stop?: StopMark;
}

/** How `requestPause` reaches the step in flight, and why the operator paused. */
export interface PauseRequest {
  readonly mode: InterruptMode;
  readonly reason?: string | undefined;
}

/** A tree's external pause (#1341c): the mark while it is set, and the fence that outlives it. */
export interface PauseMarks {
  /** Present while the tree is paused from outside. */
  readonly pause?: { readonly reason?: string; readonly mode: InterruptMode };
  /** The highest token of the tree's root lease an `Immediate` pause fenced; never lowered. */
  readonly fencedThroughToken?: number;
}

/** A tree's stop mark: how its stop was requested. */
export interface StopMark {
  readonly mode: InterruptMode;
}
