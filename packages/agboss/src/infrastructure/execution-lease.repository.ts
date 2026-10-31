import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { StoreClock, waitOf } from "./clock.js";
import {
  IN_MEMORY_DATABASE,
  treeKeyOf,
  type ExecutionLeaseRow,
  type InMemoryDatabase,
} from "./in-memory-database.js";

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
 * The time a lease ending at `expiresAt` has left at `now` (#533), both on the store's clock: whole
 * milliseconds rounded down — a store never overstates it — and never below 0.
 */
export const remainingOf = (expiresAt: Date, now: Date): Milliseconds =>
  waitOf(Math.floor(expiresAt.getTime() - now.getTime()));

/**
 * How a fenced-effect or an outbound-call store checks the lease against its write (#526):
 * `static leaseCheck` of the store.
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
 * Infrastructure (#265, Q58): one lease per execution tree, keyed by `(tenantId,
 * rootExecutionId)` — atomic and lease-based, so a lease expires by itself when its holder dies.
 * Listed only in `@Application({ providers })`; the built-in default is in memory. Your own
 * `extends ExecutionLeaseRepository`. The store decides expiry by its own time (#533, `StoreClock`:
 * a networked store's database clock, inside each statement; in-memory and SQLite the host's) and
 * answers the time left (`remaining`), never an instant a holder would compare with its own clock.
 */
export abstract class ExecutionLeaseRepository {
  /**
   * The backend the store's rows live in (#526): `"<kind>"` or `"<kind>:<database>"` —
   * `"postgres"`, `"postgres:billing"` for a second database of one kind. Two stores share one
   * transactional backend exactly when they declare the same text: a listed fenced-effect or
   * outbound-call store checks the lease in its own transaction, so its `backend` must be its lease
   * store's (`[application.store-backend-mismatch]`, `[application.store-backend-undeclared]`).
   * Unset: undeclared.
   */
  static readonly backend: string | undefined = undefined;

  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;

  /**
   * Keeps a new execution's identity (#591) — a root, a child or a recursion level — before
   * anything else of it is written: `true` when no execution ever had `executionId`, under any
   * tenant; `false` otherwise, nothing written. One atomic insert-if-absent: of concurrent calls
   * with one id, on any instances, exactly one gets `true`. Never removed — a finished, failed or
   * cancelled execution's id is never handed out again — and independent of the leases: `acquire`
   * of an existing tree (a resume, a recovery) never asks it.
   */
  abstract saveExecutionIdIfAbsent(identity: ExecutionIdentity): Promise<boolean>;

  /**
   * The tree's lease for `lease` from now; `undefined` while another holder's lease is valid, and
   * for good once its holder finished it (`finish`, #520).
   */
  abstract acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined>;

  /**
   * Extends the lease by `lease` from now and answers the time it has left (#533: `remaining`, on
   * the store's clock — never shorter than before); `undefined` once it is over — expired (`now >=
   * expiresAt`, #534: the instant of expiry belongs to the next taker, the holder included), taken
   * by another holder, or released — and the caller must stop moving the tree.
   */
  abstract renew(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<Milliseconds | undefined>;

  /** Gives the lease up at once (the tree paused, finished or failed); another holder's is kept. */
  abstract release(executionLease: ExecutionLease): Promise<void>;

  /**
   * Gives the lease up for good (#520): the work under it is over — an `AnyInstance` child that
   * answered or failed — so no later `acquire` of its key gets a lease, whoever asks and whenever,
   * and no takeover of finished work can follow. One atomic step, matched as `release` matches
   * (another holder's lease is kept, nothing finished); a finished lease is renewed, yielded and
   * reclaimed no more.
   */
  abstract finish(executionLease: ExecutionLease): Promise<void>;

  /**
   * Marks the holder's lease yielded (#516): its holder waits for children on any instance and no
   * step of the tree runs. It is not a release — the lease stays the holder's: `acquire` of another
   * instance is refused while it is valid, `renew` keeps it (still yielded), and once it expired it
   * is taken over like a held one (`takenOverFrom`). `false` when the caller no longer holds it (as
   * for `renew`: expired at `now >= expiresAt` too, #534).
   */
  abstract yield(executionLease: ExecutionLease): Promise<boolean>;

  /**
   * The holder takes its lease back (#516: after a yield, before a step runs again) at
   * `leaseEpoch + 1`, held again for `lease` from now, with no `takenOverFrom`; `undefined` when it
   * is no longer the caller's (expired at `now >= expiresAt`, #534 — taken or not —, or released) —
   * the lease `renew` would keep. An expired holder `acquire`s again: a takeover from itself.
   */
  abstract reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined>;
}

/** Whether `acquire` refuses a stored lease: still held, or finished (#520). */
const isRefused = (stored: ExecutionLeaseRow, now: Date): boolean =>
  stored.isFinished === true || (!stored.released && isLiveAt(stored.lease, now));

/**
 * Whether a lease is live at `now` (#534): while `expiresAt > now`, and only then — the one boundary
 * of every check of a lease (`acquire`, `renew`, `yield`, `reclaim`, a fenced write, `leaseStateOf`).
 */
export const isLiveAt = (lease: { readonly expiresAt: Date }, now: Date): boolean =>
  lease.expiresAt.getTime() > now.getTime();

/** Whether `stored` is the very lease the caller holds (its holder and epoch). */
const isSameLease = (stored: ExecutionLease, held: ExecutionLease): boolean =>
  stored.leaseEpoch === held.leaseEpoch && stored.holderInstanceId === held.holderInstanceId;

/**
 * The built-in default: leases in this instance's memory — every operation is one synchronous
 * step, so it is atomic. With one instance nothing contends; the instances of one test share it. A
 * yielded lease is its row with `isYielded` (#516): read by nothing but the people looking at it; a
 * finished one (#520) its released row with `isFinished`, never acquired again. Every execution id
 * handed out is a row of `executionIds` (#591), kept for the instance's life.
 */
@Injectable({ deps: [StoreClock, ApplicationContext, IN_MEMORY_DATABASE] })
export class InMemoryExecutionLeaseRepository extends ExecutionLeaseRepository {
  static override readonly backend: string | undefined = "in-memory";

  constructor(
    private readonly clock: Pick<StoreClock, "now">,
    private readonly applicationContext: ApplicationContext,
    private readonly database: InMemoryDatabase,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveExecutionIdIfAbsent(identity: ExecutionIdentity): Promise<boolean> {
    const { executionIds } = this.database;
    if (executionIds.has(identity.executionId)) return Promise.resolve(false);
    executionIds.add(identity.executionId);
    return Promise.resolve(true);
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(tenantId, rootExecutionId);
    const now = this.clock.now();
    const stored = this.database.executionLeases.get(key);
    if (stored !== undefined && isRefused(stored, now)) return Promise.resolve(undefined);
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.applicationContext.instanceId,
      leaseEpoch: (stored?.lease.leaseEpoch ?? 0) + 1,
      expiresAt: new Date(now.getTime() + lease),
      remaining: lease,
      // held is false here: a stored lease not released has expired; a superseded one had (#508)
      ...takenOverFromOf(
        stored?.lease,
        stored?.released === false || stored?.isSuperseded === true,
      ),
    };
    this.database.executionLeases.set(key, { lease: taken, released: false });
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<Milliseconds | undefined> {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.#heldOf(key, executionLease);
    if (stored === undefined) return Promise.resolve(undefined);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + lease);
    this.database.executionLeases.set(key, { ...stored, lease: { ...stored.lease, expiresAt } });
    return Promise.resolve(remainingOf(expiresAt, now));
  }

  release(executionLease: ExecutionLease): Promise<void> {
    this.#released(executionLease, false);
    return Promise.resolve();
  }

  finish(executionLease: ExecutionLease): Promise<void> {
    this.#released(executionLease, true);
    return Promise.resolve();
  }

  /** Releases the caller's own lease — for good when `isFinished` (#520); another's is kept. */
  #released(executionLease: ExecutionLease, isFinished: boolean): void {
    const key = treeKeyOf(executionLease.tenantId, executionLease.rootExecutionId);
    const stored = this.database.executionLeases.get(key);
    if (stored === undefined || !isSameLease(stored.lease, executionLease)) return;
    const finished = isFinished || stored.isFinished === true;
    this.database.executionLeases.set(key, {
      lease: stored.lease,
      released: true,
      ...(finished ? { isFinished: true } : {}),
    });
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
    const reclaimed = {
      ...{ tenantId, rootExecutionId, holderInstanceId, leaseEpoch, expiresAt },
      remaining: lease,
    };
    this.database.executionLeases.set(key, { lease: reclaimed, released: false });
    return Promise.resolve(reclaimed);
  }

  /**
   * The stored row of `key` while it is still `held` and live (#534: `expiresAt > now`) — as
   * `renew`, `yield` and `reclaim` find it; `undefined` otherwise.
   */
  #heldOf(key: string, held: ExecutionLease): ExecutionLeaseRow | undefined {
    const stored = this.database.executionLeases.get(key);
    const isHeld =
      stored !== undefined &&
      !stored.released &&
      isSameLease(stored.lease, held) &&
      isLiveAt(stored.lease, this.clock.now());
    return isHeld ? stored : undefined;
  }
}
