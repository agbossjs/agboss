import type { Clock } from "../infrastructure/clock.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../infrastructure/execution-lease.repository.js";
import { waitOf } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { ExecutionLeaseLostError, leaseExpiredError } from "./lease-lost.js";

/** The length of a tree's lease — fixed, not a setting (Q58). */
export const EXECUTION_LEASE: Milliseconds = seconds(30);

/** A third of the lease: two renewals may fail before it expires. */
export const RENEW_EVERY: Milliseconds = seconds(10);

/**
 * What the holder takes off the time its store says a lease has left (#533): the drift of its
 * monotonic clock and of the store's over one lease — the bound ρ_holder + ρ_store ≤ 1 s / 30 s.
 */
export const LEASE_SAFETY_MARGIN: Milliseconds = seconds(1);

/** Until when (monotonic ms) a lease answered `remaining` for a request sent at `sentAt` is trusted. */
export const trustedUntil = (
  sentAt: number,
  remaining: Milliseconds,
  margin: Milliseconds = LEASE_SAFETY_MARGIN,
): number => sentAt + remaining - margin;

/**
 * How long the holder may trust its lease (#335 S1, #533): until `sentAt + remaining −
 * LEASE_SAFETY_MARGIN` of the last acquire or renewal its store confirmed — `sentAt` the holder's
 * monotonic time when it sent that request, `remaining` the store's answer — so neither an offset nor
 * a step of its wall clock moves the fence; also while the holder yields the lease waiting for remote
 * children (#516: the yielded lease is renewed on). `confirmedUntil` is that deadline on the wall
 * clock, for reading only.
 */
export class LeaseFence {
  /** The deadline on the holder's monotonic clock. */
  #until: number;

  constructor(
    private readonly clock: Clock,
    { sentAt, remaining }: { readonly sentAt: number; readonly remaining: Milliseconds },
    private readonly lost: AbortController,
    private readonly rootExecutionId: string,
    /** What it takes off each answer: `LEASE_SAFETY_MARGIN` (a test proves it bites with less). */
    private readonly margin: Milliseconds = LEASE_SAFETY_MARGIN,
  ) {
    this.#until = trustedUntil(sentAt, remaining, margin);
  }

  /** The time (wall-clock ms) up to which the lease is valid here: the monotonic deadline, projected. */
  get confirmedUntil(): number {
    return this.clock.now().getTime() + this.left;
  }

  /** How long (ms) the lease is still valid here, on the monotonic clock; ≤ 0 once it ran out. */
  get left(): number {
    return this.#until - this.clock.monotonicNow();
  }

  /** The lease was reclaimed after a remote child wait (#333 PR 4, #516), sent at `sentAt`. */
  reacquired(sentAt: number, remaining: Milliseconds): void {
    this.lost.signal.throwIfAborted();
    this.#until = trustedUntil(sentAt, remaining, this.margin);
  }

  /**
   * Aborts the holder: another instance took the lease (or this instance can no longer acquire it),
   * or an external system fenced one of its writes (`reason`, #471).
   */
  lose(reason: ExecutionLeaseLostError = new ExecutionLeaseLostError(this.rootExecutionId)): never {
    if (!this.lost.signal.aborted) this.lost.abort(reason);
    throw this.lost.signal.reason;
  }

  /** Aborts the holder: the lease ran out with no renewal the store confirmed. */
  expire(): void {
    if (!this.lost.signal.aborted) this.lost.abort(leaseExpiredError(this.rootExecutionId));
  }

  /** Expires the lease once it ran out here (#533: on the monotonic clock); throws once lost. */
  check(): void {
    this.lost.signal.throwIfAborted();
    if (this.left <= 0) this.expire();
    this.lost.signal.throwIfAborted();
  }

  /**
   * A renewal sent at `sentAt` answered: a `remaining` time moves the fence on (never back), `false`
   * (over) aborts, `undefined` (the store did not answer) aborts only once the lease ran out here —
   * before that the caller's write goes on. Throws the holder's `ExecutionLeaseLostError` once aborted.
   */
  settle(sentAt: number, renewed: Milliseconds | false | undefined): void {
    this.lost.signal.throwIfAborted();
    if (renewed === false) this.lose();
    if (renewed !== undefined)
      this.#until = Math.max(this.#until, trustedUntil(sentAt, renewed, this.margin));
    this.check();
  }
}

/**
 * Renews every third of the lease until stopped or lost; a store error is retried next time (the
 * expiry below stops the holder when none succeeds in time).
 */
export async function renewInBackground(
  clock: Clock,
  working: AbortSignal,
  renewNow: () => Promise<void>,
): Promise<void> {
  for (;;) {
    await clock.sleep(RENEW_EVERY, working);
    if (working.aborted) return;
    try {
      await renewNow();
    } catch (error) {
      if (error instanceof ExecutionLeaseLostError) return;
    }
  }
}

/**
 * Sleeps until the lease runs out here (`confirmedUntil`, moved on by every confirmed renewal) and
 * then expires it (#335): the holder stops at the lease's end even while its store does not answer.
 */
export async function expireInBackground(
  clock: Clock,
  working: AbortSignal,
  fence: LeaseFence,
): Promise<void> {
  for (;;) {
    const { left } = fence;
    if (left <= 0) {
      fence.expire();
      return;
    }
    const sleepFor = Number.isFinite(left) ? waitOf(left) : RENEW_EVERY;
    await clock.sleep(sleepFor, working);
    if (working.aborted) return;
  }
}

/**
 * A renewal of `held` in the store, sent now (`sentAt`, the monotonic clock, #533): `renewed` the
 * time the store says the lease has left, `false` when it is over, `undefined` when the store did not
 * answer.
 */
export async function renewalOf(
  { clock, repository }: { readonly clock: Clock; readonly repository: ExecutionLeaseRepository },
  held: ExecutionLease,
): Promise<{ readonly sentAt: number; readonly renewed: Milliseconds | false | undefined }> {
  const sentAt = clock.monotonicNow();
  const renewed = await repository.renew(held, EXECUTION_LEASE).then(
    (remaining) => remaining ?? false,
    (): undefined => undefined,
  );
  return { sentAt, renewed };
}
