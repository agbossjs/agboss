import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import type { HeldExecutionLease, RenewalCheck } from "./execution-leases.js";
import {
  LeaseEventReports,
  reacquiredOf,
  reportTake,
  type LeaseTake,
  type LeaseTaking,
} from "./execution-leases.js";
import type { FencedEffectReport, HandOverReport, OutboundCallReport } from "./lease-events.js";
import { FencedHolders, isHandedOver } from "./handed-over.js";
import {
  EXECUTION_LEASE,
  expireInBackground,
  LeaseFence,
  renewalOf,
  renewInBackground,
} from "./lease-fence.js";
import {
  leaseTakenWhileYieldedError,
  scopeKeyOf,
  type ExecutionFencedError,
} from "./lease-lost.js";
import { leaseReleases } from "./lease-releases.js";
import { LeaseAttempts, LeaseTurns, LeaseYields } from "./lease-yields.js";
import type { Milliseconds } from "../units/index.js";

/**
 * How a held lease began: when it was asked for (`sentAt`, the clock's monotonic ms, #533) and why
 * it was taken (#501).
 */
export interface HeldLeaseStart {
  readonly sentAt: number;
  readonly take?: LeaseTake | undefined;
}

/**
 * A tree's lease held by this instance (`execution-leases.ts`): renewed and watched in the
 * background, fenced locally (#335), read by its steps' `executionContext.fence` (#471: its token,
 * its checks, a fenced write stopping it), yielded while every caller waits for remote children and
 * no step of the tree runs (#333 PR 4, #471) — yielded in the store, not released (#516): the lease
 * stays this holder's and is renewed on, so no other instance takes the waiting tree over.
 */
export class HeldLease implements HeldExecutionLease {
  readonly rootExecutionId: string;
  readonly leaseExecutionId: string;
  readonly tenantId: string;
  readonly scopeKey: string;
  readonly signal: AbortSignal;
  readonly #key: string;
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
    await (shouldYield ? this.#yieldLease() : this.#reacquireLease());
  });
  /** Who a fenced write of the current token stops: this holder (#471). */
  readonly #holder: FencedHolders;
  /** Why it was taken (#501): a re-acquire is recorded for the same tree. */
  readonly #take: LeaseTake | undefined;
  /** The hand-overs being recorded (#501): the lease is released only after them. */
  readonly #reports = new LeaseEventReports();
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
    this.repository = taking.repository;
    this.clock = taking.clock;
    this.#attempts = new LeaseAttempts(this.clock);
    this.#take = take;
    this.#reports.held(initial);
    this.rootExecutionId = tree.rootExecutionId;
    this.leaseExecutionId = tree.rootExecutionId;
    this.tenantId = tree.tenantId;
    this.scopeKey = scopeKeyOf(tree.tenantId, tree.rootExecutionId);
    this.signal = this.#lost.signal;
    this.#key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
    this.#current = initial;
    const start = { sentAt, remaining: initial.remaining };
    const { safetyMargin } = taking;
    this.#fence = new LeaseFence(this.clock, start, this.#lost, tree.rootExecutionId, safetyMargin);
    this.#holder = new FencedHolders(this.scopeKey, (error) => {
      this.fenced(error);
    });
    this.#holder.hold(initial.leaseEpoch);
    this.#lost.signal.addEventListener("abort", this.#holder.forget, { once: true });
    const working = AbortSignal.any([this.#stopped.signal, this.#lost.signal]);
    void renewInBackground(this.clock, working, () => this.renewNow());
    void expireInBackground(this.clock, working, this.#fence);
  }

  get token(): number | undefined {
    return this.#isYieldedNow ? undefined : this.#current?.leaseEpoch;
  }

  get confirmedUntil(): number {
    return this.#fence.confirmedUntil;
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

  async confirmNow(): Promise<void> {
    this.#lost.signal.throwIfAborted();
    const held = this.#current;
    // no step runs while the lease is yielded: a confirmation now is not this holder's
    if (held === undefined || this.#isYieldedNow) this.#fence.lose();
    const { sentAt, renewed } = await renewalOf(this.taking, held);
    // anything but a confirmed renewal is a hand-over: the tree goes on where the lease is held
    if (renewed === false || renewed === undefined) this.#fence.lose();
    this.#fence.settle(sentAt, renewed);
    for (const check of this.#checks) await check();
  }

  /** An external system fenced a write of this lease's token (#471): the holder stops with it. */
  fenced(error: ExecutionFencedError): void {
    if (!this.#lost.signal.aborted) this.#lost.abort(error);
  }

  async renewNow(): Promise<void> {
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

  recordHandOver(report: HandOverReport): void {
    this.#reports.handOver(this.taking.events, report, this.scopeKey);
  }

  recordFencedEffect(report: FencedEffectReport): void {
    this.#stepCall((record, log, holder) => record.recordFencedEffect(log, report, holder));
  }

  recordOutboundCall(report: OutboundCallReport): void {
    this.#stepCall((record, log, holder) => record.recordOutboundCall(log, report, holder));
  }

  /** A step's call under the lease, written to the lease log in the lease's order. */
  #stepCall(write: Parameters<LeaseEventReports["stepCall"]>[1]): void {
    this.#reports.stepCall(this.taking.events, write);
  }

  keepWhile(attempt: Promise<unknown>, maxWait: Milliseconds): void {
    this.#attempts.keep(attempt, maxWait, () => this.#yields.enterStep());
  }

  async release({ isFinished = false }: { readonly isFinished?: boolean } = {}): Promise<void> {
    // its attempts in flight first, renewed on meanwhile, within their bounds (#508)
    const isSettled = await this.#attempts.settled(this.#lost.signal, this.taking.stopping);
    await this.#reports.settled();
    if (this.#stopped.signal.aborted) return;
    this.#stopped.abort();
    this.#holder.forget();
    this.#isYieldedNow = false;
    // an attempt still in flight: renewals stop, nothing released — the lease expires (#508)
    if (isSettled && !this.#lost.signal.aborted && this.#current !== undefined) {
      const held = this.#current;
      this.#current = undefined;
      await (isFinished ? this.repository.finish(held) : this.repository.release(held));
    }
    leaseReleases.notify(this.#key);
  }

  /**
   * Yields the lease in the store (#516): still this holder's, renewed on. A store that did not
   * answer leaves it held there, which other instances see the same way; one that says it is no
   * longer this holder's stops the holder.
   */
  async #yieldLease(): Promise<void> {
    const held = this.#current;
    if (held === undefined || this.#isYieldedNow) return;
    this.#isYieldedNow = true;
    this.#holder.forget();
    const isYielded = await this.repository.yield(held).catch((): boolean => true);
    if (!isYielded) this.#fence.lose();
  }

  /** Takes the yielded lease back before a step runs (#516): the next token, or the holder stops. */
  async #reacquireLease(): Promise<void> {
    const held = this.#current;
    if (held === undefined || !this.#isYieldedNow) return;
    const sentAt = this.clock.monotonicNow();
    const next = await this.#turns.run(async () => {
      const reclaimed = await this.repository.reclaim(held, EXECUTION_LEASE);
      if (reclaimed !== undefined) this.#current = reclaimed;
      return reclaimed;
    });
    if (next === undefined) this.#fence.lose(leaseTakenWhileYieldedError(this.leaseExecutionId));
    this.#isYieldedNow = false;
    this.#reports.held(next);
    this.#holder.hold(next.leaseEpoch);
    this.#fence.reacquired(sentAt, next.remaining);
    await reportTake(this.taking.events, next, reacquiredOf(this.#take));
  }
}
