import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import type { HeldExecutionLease, RenewalCheck } from "./execution-leases.js";
import { reclaimedOf, reportTake, type LeaseTake, type LeaseTaking } from "./execution-leases.js";
import { FencedHolders, isHandedOver } from "./handed-over.js";
import {
  EXECUTION_LEASE,
  expireInBackground,
  LeaseFence,
  renewalOf,
  renewInBackground,
  sentAtOf,
} from "./lease-fence.js";
import {
  ExecutionLeaseLostError,
  leaseTakenWhileYieldedError,
  scopeKeyOf,
  type ExecutionFencedError,
} from "./lease-lost.js";
import { Abandonment } from "./lease-abandon.js";
import { leasedRenewal, leaseScope } from "./lease-scope.js";
import type { StoreOutcomeUnknownError } from "../infrastructure/store-call-timeout.js";
import { leaseReleases } from "./lease-releases.js";
import { LeaseAttempts, LeaseTurns, LeaseYields } from "./lease-yields.js";
import { ReportingLease } from "./lease-reporting.js";
import type { Milliseconds } from "../units/index.js";
import { heldAtRelease, heldWhileYieldsRun } from "./lease-lost.js";

/**
 * How a held lease began: when it was asked for (`sentAt`, on both of the clock's counts, #533) and why
 * it was taken (#501).
 */
export interface HeldLeaseStart {
  readonly sentAt: ReturnType<typeof sentAtOf>;
  readonly take?: LeaseTake | undefined;
}

/**
 * A tree's lease held by this instance (`execution-leases.ts`): renewed and watched in the
 * background, fenced locally (#335), read by its steps' `executionContext.fence` (#471: its token,
 * its checks, a fenced write stopping it), yielded while every caller waits for remote children and
 * no step of the tree runs (#333 PR 4, #471) — yielded in the store, not released (#516): the lease
 * stays this holder's and is renewed on, so no other instance takes the waiting tree over.
 */
export class HeldLease extends ReportingLease implements HeldExecutionLease {
  readonly rootExecutionId: string;
  readonly leaseExecutionId: string;
  readonly tenantId: string;
  readonly scopeKey: string;
  readonly signal: AbortSignal;
  readonly #checks: RenewalCheck[] = [];
  readonly #lost = new AbortController();
  readonly #stopped = new AbortController();
  readonly #fence: LeaseFence;
  #current: ExecutionLease | undefined;
  /** Whether `#current` is yielded in the store now (#516). */
  #isYieldedNow = false;
  /** The renewals and reclaims of the store, one after another (#516). */
  readonly #turns = new LeaseTurns();
  /** When the lease is yielded: never under a running step of the tree (#471). */
  readonly #yields = new LeaseYields(async (shouldYield) => {
    if (this.#stopped.signal.aborted || this.#lost.signal.aborted) return;
    const held = heldWhileYieldsRun(this.#current);
    await (shouldYield ? this.#yieldLease(held) : this.#reclaimLease(held));
  });
  /** Who a fenced write of the current token stops: this holder (#471). */
  readonly #holder: FencedHolders;
  /** Why it was taken (#501): a reclaim is recorded for the same tree. */
  readonly #take: LeaseTake | undefined;
  /** The hand-over of an unanswered store call (#928), once. */
  readonly #abandonment = new Abandonment();
  /** The outbound calls' attempts in flight under it (#508): released only once they settled. */
  readonly #attempts: LeaseAttempts;

  private readonly repository: ExecutionLeaseRepository;
  private readonly clock: Clock;

  constructor(
    private readonly taking: LeaseTaking,
    private readonly tree: ExecutionTree,
    initial: ExecutionLease,
    { sentAt, take }: HeldLeaseStart,
  ) {
    super(taking.events);
    this.repository = taking.repository;
    this.clock = taking.clock;
    this.#attempts = new LeaseAttempts(this.clock);
    this.#take = take;
    this.reports.held(initial);
    this.rootExecutionId = this.leaseExecutionId = tree.rootExecutionId;
    this.tenantId = tree.tenantId;
    this.scopeKey = scopeKeyOf(tree.tenantId, tree.rootExecutionId);
    this.signal = this.#lost.signal;
    this.#current = initial;
    const start = { sentAt, remaining: initial.remaining, margin: taking.safetyMargin };
    this.#fence = new LeaseFence(this.clock, start, this.#lost, tree.rootExecutionId);
    this.#holder = new FencedHolders(this.scopeKey, this.fenced.bind(this));
    this.#holder.hold(initial.token);
    // Stryker disable next-line CallExpression,StringLiteral,ObjectLiteral,BooleanLiteral: the abort event fires once and its holder is forgotten at the release as well; a fenced write of a lost holder's token only aborts what is aborted already
    this.#lost.signal.addEventListener("abort", this.#holder.forget, { once: true });
    const working = AbortSignal.any([this.#stopped.signal, this.#lost.signal]);
    taking.heldLeases?.hold(working);
    void renewInBackground(this.clock, working, () => this.renew());
    void expireInBackground(this.clock, working, this.#fence);
  }

  get token(): number | undefined {
    return this.#isYieldedNow ? undefined : this.#current?.token;
  }

  get trustedUntil(): number {
    return this.#fence.trustedUntil;
  }

  get left(): number {
    return this.#fence.left;
  }

  get isYielded(): boolean {
    return this.#isYieldedNow && !this.#lost.signal.aborted;
  }

  afterEachRenewal(check: RenewalCheck): void {
    this.#checks.push(check);
  }

  assertHeld(): void {
    this.#fence.check();
  }

  async renewNow(): Promise<void> {
    this.#lost.signal.throwIfAborted();
    const held = this.#current;
    // no step runs while the lease is yielded: a confirmation now is not this holder's
    if (held === undefined || this.#isYieldedNow) this.#fence.lose();
    // unanswered, it hands over (#928): the one renewal that is bounded by the lease's trust
    const { sentAt, renewed } = await leasedRenewal(this, () => renewalOf(this.taking, held));
    // anything but a confirmed renewal is a hand-over: the tree goes on where the lease is held
    if (typeof renewed !== "number") this.#fence.lose();
    this.#fence.settle(sentAt, renewed);
    for (const check of this.#checks) await check();
  }

  /** An external system fenced a write of this lease's token (#471): the holder stops with it. */
  fenced(error: ExecutionFencedError): void {
    // a no-op once aborted: the first reason stays
    this.#lost.abort(error);
  }

  async renew(): Promise<void> {
    this.#lost.signal.throwIfAborted();
    const renewal = await this.#turns.run(async () => {
      const held = this.#current;
      return held === undefined ? undefined : { held, ...(await renewalOf(this.taking, held)) };
    });
    if (renewal === undefined) {
      for (const check of this.#checks) await check();
      return;
    }
    // released meanwhile: the answer is for a lease this holder gave up
    if (renewal.held !== this.#current) return;
    this.#fence.settle(renewal.sentAt, renewal.renewed);
    if (typeof renewal.renewed === "number") for (const check of this.#checks) await check();
  }

  enterStep(): Promise<() => void> {
    return this.#yields.enterStep();
  }

  async yieldWhile<T>(wait: () => Promise<T>): Promise<T> {
    let handedOver = false;
    try {
      await this.#yields.startWaiting();
      return await wait();
    } catch (error) {
      handedOver = isHandedOver(error);
      throw error;
    } finally {
      await this.#yields.stopWaiting(handedOver);
    }
  }

  keepWhile(attempt: Promise<unknown>, maxWait: Milliseconds): void {
    this.#attempts.keep(attempt, maxWait, () => this.#yields.enterStep());
  }

  /**
   * A store call under the lease did not answer (#928): the holder stops as at the lease's expiry —
   * its signal aborted, the renewals and the expiry loop stopped, its token no more a fenced
   * holder's — once the hand-over rows are written. Nothing is released and no waiter woken as if
   * the lease were free: it expires in the store, and only then is the tree taken over.
   */
  abandon(cause: StoreOutcomeUnknownError): Promise<void> {
    return this.#abandonment.run(cause, async () => {
      const lost = new ExecutionLeaseLostError({ rootExecutionId: this.rootExecutionId, cause });
      // the abort stops the renewals and the expiry loop and forgets the holder (its listener)
      this.#lost.abort(lost);
      await this.reports.settled();
    });
  }

  async release({ isRetired = false }: { readonly isRetired?: boolean } = {}): Promise<void> {
    // its attempts in flight first, renewed on meanwhile, within their bounds (#508)
    const isSettled = await this.#attempts.settled(this.#lost.signal, this.taking.stopping);
    await this.reports.settled();
    const lease = { executionId: this.rootExecutionId, tenantId: this.tenantId };
    const token = this.#current?.token;
    if (this.#abandonment.told(this.taking.events?.log, { ...lease, token })) return;
    if (this.#stopped.signal.aborted) return;
    this.#stopped.abort();
    this.#holder.forget();
    this.#isYieldedNow = false;
    // an attempt still in flight: renewals stop, nothing released — the lease expires (#508)
    if (isSettled && !this.#lost.signal.aborted) {
      const held = heldAtRelease(this.#current);
      this.#current = undefined;
      await (isRetired ? this.repository.retire(held) : this.repository.release(held));
    }
    leaseReleases.notify(treeKeyOf(this.tenantId, this.rootExecutionId));
  }

  /**
   * Yields the lease in the store (#516): still this holder's, renewed on. A store that did not
   * answer leaves it held there, which other instances see the same way; one that says it is no
   * longer this holder's stops the holder.
   */
  async #yieldLease(held: ExecutionLease): Promise<void> {
    if (this.#isYieldedNow) return;
    this.#isYieldedNow = true;
    this.#holder.forget();
    // the time left is unused (a yield extends nothing); null: the store did not answer
    if ((await this.repository.yield(held).catch(() => null)) === undefined) this.#fence.lose();
  }

  /** Takes the yielded lease back before a step runs (#516): the next token, or the holder stops. */
  async #reclaimLease(held: ExecutionLease): Promise<void> {
    if (!this.#isYieldedNow) return;
    const sentAt = sentAtOf(this.clock);
    const next = await this.#turns.run(async () => {
      // unanswered, it hands over (#928): its token is never trusted, so it expires
      const reclaimed = await leaseScope(this, () =>
        this.repository.reclaim(held, EXECUTION_LEASE),
      );
      // in the turn, so the next renewal renews the reclaimed lease; a failed one changes nothing
      this.#current = reclaimed ?? this.#current;
      return reclaimed;
    });
    if (next === undefined) this.#fence.lose(leaseTakenWhileYieldedError(this.leaseExecutionId));
    this.#isYieldedNow = false;
    this.reports.held(next);
    this.#holder.hold(next.token);
    this.#fence.reclaimed(sentAt, next.remaining);
    await reportTake(this.taking.events, next, reclaimedOf(this.#take));
  }
}
