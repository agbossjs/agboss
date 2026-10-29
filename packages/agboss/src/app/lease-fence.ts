import type { Clock } from "../infrastructure/clock.js";
import { waitOf } from "../infrastructure/clock-timeout.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { ExecutionLeaseLostError, leaseExpiredError } from "./lease-lost.js";

/** The length of a tree's lease — fixed, not a setting (Q58). */
export const EXECUTION_LEASE: Milliseconds = seconds(30);

/** A third of the lease: two renewals may fail before it expires. */
export const RENEW_EVERY: Milliseconds = seconds(10);

/**
 * How long the holder may trust its lease (#335 S1): until `confirmedUntil`, the `Clock` read
 * before the last acquire or renewal its store confirmed plus the lease's length. While the holder
 * yields the lease waiting for remote children (#333 PR 4), the fence waits until it is re-acquired.
 */
export class LeaseFence {
  #confirmedUntil: number;

  constructor(
    private readonly clock: Clock,
    askedAt: number,
    private readonly lost: AbortController,
    private readonly rootExecutionId: string,
  ) {
    this.#confirmedUntil = askedAt + EXECUTION_LEASE;
  }

  /** The time (ms) up to which the lease is valid here (`POSITIVE_INFINITY` while yielded). */
  get confirmedUntil(): number {
    return this.#confirmedUntil;
  }

  /** The lease was yielded while remote children run (#333 PR 4): it cannot expire until re-acquired. */
  yield(): void {
    this.#confirmedUntil = Number.POSITIVE_INFINITY;
  }

  /** The lease was re-acquired after a remote child wait (#333 PR 4), asked at `askedAt`. */
  reacquired(askedAt: number): void {
    this.lost.signal.throwIfAborted();
    this.#confirmedUntil = askedAt + EXECUTION_LEASE;
  }

  /** Whether the lease is yielded while remote children run (#333 PR 4): no time to trust. */
  get isYielded(): boolean {
    return this.#confirmedUntil === Number.POSITIVE_INFINITY;
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

  /**
   * A renewal asked at `renewedAt` answered: `true` moves the fence on, `false` (taken) aborts,
   * `undefined` (the store did not answer) aborts only once the lease ran out here — before that
   * the caller's write goes on. Throws the holder's `ExecutionLeaseLostError` once aborted.
   */
  settle(renewedAt: number, isRenewed: boolean | undefined): void {
    this.lost.signal.throwIfAborted();
    if (isRenewed === true) {
      this.#confirmedUntil = Math.max(this.#confirmedUntil, renewedAt + EXECUTION_LEASE);
      return;
    }
    if (isRenewed === false) this.lose();
    if (this.clock.now().getTime() >= this.#confirmedUntil) this.expire();
    this.lost.signal.throwIfAborted();
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
    const left = fence.confirmedUntil - clock.now().getTime();
    if (left <= 0) {
      fence.expire();
      return;
    }
    const sleepFor = Number.isFinite(left) ? waitOf(left) : RENEW_EVERY;
    await clock.sleep(sleepFor, working);
    if (working.aborted) return;
  }
}
