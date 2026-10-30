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
import type { FencedEffectReport, HandOverReport } from "./lease-events.js";
import { FencedHolders, isHandedOver } from "./handed-over.js";
import {
  EXECUTION_LEASE,
  expireInBackground,
  LeaseFence,
  renewInBackground,
} from "./lease-fence.js";
import { scopeKeyOf, type ExecutionFencedError } from "./lease-lost.js";
import { leaseReleases } from "./lease-releases.js";
import { LeaseYields } from "./lease-yields.js";

/** How a held lease began: when it was asked for (the clock's ms) and why it was taken (#501). */
export interface HeldLeaseStart {
  readonly askedAt: number;
  readonly take?: LeaseTake | undefined;
}

/**
 * A tree's lease held by this instance (`execution-leases.ts`): renewed and watched in the
 * background, fenced locally (#335), read by its steps' `executionContext.fence` (#471: its token,
 * its checks, a fenced write stopping it), yielded while every caller waits for remote children and
 * no step of the tree runs (#333 PR 4, #471).
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

  private readonly repository: ExecutionLeaseRepository;
  private readonly clock: Clock;

  constructor(
    private readonly taking: LeaseTaking,
    private readonly tree: ExecutionTree,
    initial: ExecutionLease,
    { askedAt, take }: HeldLeaseStart,
  ) {
    this.repository = taking.repository;
    this.clock = taking.clock;
    this.#take = take;
    this.#reports.held(initial);
    const { clock } = taking;
    this.rootExecutionId = tree.rootExecutionId;
    this.leaseExecutionId = tree.rootExecutionId;
    this.tenantId = tree.tenantId;
    this.scopeKey = scopeKeyOf(tree.tenantId, tree.rootExecutionId);
    this.signal = this.#lost.signal;
    this.#key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
    this.#current = initial;
    this.#fence = new LeaseFence(clock, askedAt, this.#lost, tree.rootExecutionId);
    this.#holder = new FencedHolders(this.scopeKey, (error) => {
      this.fenced(error);
    });
    this.#holder.hold(initial.leaseEpoch);
    this.#lost.signal.addEventListener("abort", this.#holder.forget, { once: true });
    const working = AbortSignal.any([this.#stopped.signal, this.#lost.signal]);
    void renewInBackground(clock, working, () => this.renewNow());
    void expireInBackground(clock, working, this.#fence);
  }

  get token(): number | undefined {
    return this.#current?.leaseEpoch;
  }

  get confirmedUntil(): number {
    return this.#fence.confirmedUntil;
  }

  get isYielded(): boolean {
    return this.#current === undefined && !this.#lost.signal.aborted;
  }

  afterEachRenewal(check: RenewalCheck): void {
    this.#checks.push(check);
  }

  assertHeld(): void {
    this.#lost.signal.throwIfAborted();
    if (this.clock.now().getTime() >= this.#fence.confirmedUntil) this.#fence.expire();
    this.#lost.signal.throwIfAborted();
  }

  async confirmNow(): Promise<void> {
    this.#lost.signal.throwIfAborted();
    const held = this.#current;
    if (held === undefined) this.#fence.lose();
    const { renewedAt, isRenewed } = await this.#renewed(held);
    // anything but a confirmed renewal is a hand-over: the tree goes on where the lease is held
    if (isRenewed !== true) this.#fence.lose();
    this.#fence.settle(renewedAt, true);
    for (const check of this.#checks) await check();
  }

  /** An external system fenced a write of this lease's token (#471): the holder stops with it. */
  fenced(error: ExecutionFencedError): void {
    if (!this.#lost.signal.aborted) this.#lost.abort(error);
  }

  async renewNow(): Promise<void> {
    this.#lost.signal.throwIfAborted();
    if (this.#current === undefined) {
      for (const check of this.#checks) await check();
      return;
    }
    const { renewedAt, isRenewed } = await this.#renewed(this.#current);
    this.#fence.settle(renewedAt, isRenewed);
    if (isRenewed === true) for (const check of this.#checks) await check();
  }

  enterStep(): Promise<() => void> {
    return this.#yields.enterStep();
  }

  async yieldWhile<T>(wait: () => Promise<T>): Promise<T> {
    const unyield = leaseReleases.enterYielded(this.#key);
    let handedOver = false;
    try {
      await this.#yields.startWaiting();
      return await wait();
    } catch (error) {
      handedOver = isHandedOver(error);
      throw error;
    } finally {
      unyield();
      await this.#yields.stopWaiting(handedOver);
    }
  }

  recordHandOver(report: HandOverReport): void {
    this.#reports.handOver(this.taking.events, report, this.scopeKey);
  }

  recordFencedEffect(report: FencedEffectReport): void {
    this.#reports.fencedEffect(this.taking.events, report);
  }

  async release(): Promise<void> {
    await this.#reports.settled();
    if (this.#stopped.signal.aborted) return;
    this.#stopped.abort();
    this.#holder.forget();
    if (!this.#lost.signal.aborted && this.#current !== undefined) {
      const held = this.#current;
      this.#current = undefined;
      await this.repository.release(held);
    }
    leaseReleases.notify(this.#key);
  }

  async #yieldLease(): Promise<void> {
    if (this.#current === undefined) return;
    const held = this.#current;
    this.#current = undefined;
    this.#holder.forget();
    this.#fence.yield();
    await this.repository.release(held);
    leaseReleases.notify(this.#key);
  }

  async #reacquireLease(): Promise<void> {
    if (this.#current !== undefined) return;
    const at = this.clock.now().getTime();
    const next = await this.repository.acquire(
      this.tree.tenantId,
      this.tree.rootExecutionId,
      EXECUTION_LEASE,
    );
    if (next === undefined) this.#fence.lose();
    this.#current = next;
    this.#reports.held(next);
    this.#holder.hold(next.leaseEpoch);
    this.#fence.reacquired(at);
    await reportTake(this.taking.events, next, reacquiredOf(this.#take));
  }

  /** A renewal in the store, asked now: `undefined` when the store did not answer. */
  async #renewed(held: ExecutionLease) {
    const renewedAt = this.clock.now().getTime();
    const isRenewed = await this.repository
      .renew(held, EXECUTION_LEASE)
      .catch((): undefined => undefined);
    return { renewedAt, isRenewed };
  }
}
