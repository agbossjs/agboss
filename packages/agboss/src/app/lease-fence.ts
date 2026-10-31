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

/**
 * When the holder sent a request to its store (#533): its monotonic time and its wall time, read
 * together right before the request — never when the answer came.
 */
export interface SentAt {
  readonly monotonic: number;
  readonly wall: number;
}

/** Now, on both of the holder's clocks: the `sentAt` of a request about to be sent. */
export const sentAtOf = (clock: Clock): SentAt => ({
  monotonic: clock.monotonicNow(),
  wall: clock.now().getTime(),
});

/**
 * The time a store's answer says is left, as the holder trusts it (#533): a finite number of ms ≥ 0,
 * never more than the lease it asked for. Anything else — no `remaining` (a store on the contract
 * before #533), `NaN`, `Infinity`, a boolean — is 0: the holder fails closed.
 */
export const trustedRemaining = (
  remaining: unknown,
  asked: Milliseconds = EXECUTION_LEASE,
): Milliseconds =>
  waitOf(
    // Stryker disable next-line ConditionalExpression: `Number.isFinite` is false for every non-number, so the `typeof` test changes no answer
    typeof remaining === "number" && Number.isFinite(remaining) ? Math.min(remaining, asked) : 0,
  );

/** How a fence begins: its first answer, the request's `sentAt`, and the margin (default 1 s). */
export interface FenceStart {
  readonly sentAt: SentAt;
  readonly remaining: unknown;
  readonly margin?: Milliseconds | undefined;
}

/** The two deadlines of a fence: on the monotonic clock and on the wall clock. */
interface Deadlines {
  readonly monotonic: number;
  readonly wall: number;
}

/** The deadlines of an answer `remaining` to a request sent at `sentAt`, less `margin`. */
const deadlinesOf = (sentAt: SentAt, remaining: unknown, margin: Milliseconds): Deadlines => {
  const trusted = trustedRemaining(remaining) - margin;
  return { monotonic: sentAt.monotonic + trusted, wall: sentAt.wall + trusted };
};

/**
 * How long the holder may trust its lease (#335 S1, #533): until `sentAt + remaining −
 * LEASE_SAFETY_MARGIN` of the last acquire or renewal its store confirmed — `sentAt` when the holder
 * sent that request, `remaining` the store's answer. Counted on both of its clocks from `sentAt`,
 * and over at the earlier: an offset of its wall clock moves neither; a step of its wall clock back
 * is bounded by the monotonic count, a step forward or a suspend of the host (which stops the
 * monotonic clock while the store's time runs on) by the wall count. The wall clock only ever ends
 * the fence earlier, never later. `confirmedUntil` is that deadline on the wall clock, for reading.
 */
export class LeaseFence {
  #until: Deadlines;
  /** What it takes off each answer: `LEASE_SAFETY_MARGIN` (a test proves it bites with less). */
  private readonly margin: Milliseconds;

  constructor(
    private readonly clock: Clock,
    start: FenceStart,
    private readonly lost: AbortController,
    private readonly rootExecutionId: string,
  ) {
    this.margin = start.margin ?? LEASE_SAFETY_MARGIN;
    this.#until = deadlinesOf(start.sentAt, start.remaining, this.margin);
  }

  /** The time (wall-clock ms) up to which the lease is valid here, for reading. */
  get confirmedUntil(): number {
    return this.clock.now().getTime() + this.left;
  }

  /** How long (ms) the lease is still valid here, the earlier of its two counts; ≤ 0 once over. */
  get left(): number {
    const monotonic = this.#until.monotonic - this.clock.monotonicNow();
    const wall = this.#until.wall - this.clock.now().getTime();
    return Math.min(monotonic, wall);
  }

  /** The lease was reclaimed after a remote child wait (#333 PR 4, #516), sent at `sentAt`. */
  reacquired(sentAt: SentAt, remaining: unknown): void {
    this.lost.signal.throwIfAborted();
    this.#until = deadlinesOf(sentAt, remaining, this.margin);
  }

  /**
   * Aborts the holder: another instance took the lease (or this instance can no longer acquire it),
   * or an external system fenced one of its writes (`reason`, #471).
   */
  lose(reason: ExecutionLeaseLostError = new ExecutionLeaseLostError(this.rootExecutionId)): never {
    // Stryker disable next-line ConditionalExpression: aborting an aborted controller is a no-op that keeps its first reason
    if (!this.lost.signal.aborted) this.lost.abort(reason);
    throw this.lost.signal.reason;
  }

  /** Aborts the holder: the lease ran out with no renewal the store confirmed. */
  expire(): void {
    // Stryker disable next-line ConditionalExpression: aborting an aborted controller is a no-op that keeps its first reason
    if (!this.lost.signal.aborted) this.lost.abort(leaseExpiredError(this.rootExecutionId));
  }

  /** Expires the lease once it ran out here (#533: the earlier of its two counts); throws once lost. */
  check(): void {
    // Stryker disable next-line CallExpression: an aborted fence still throws its reason at the check's last line, as `expire()` keeps the first reason
    this.lost.signal.throwIfAborted();
    if (!(this.left > 0)) this.expire();
    this.lost.signal.throwIfAborted();
  }

  /**
   * A renewal sent at `sentAt` answered: a `remaining` time moves each deadline on (never back),
   * `false` (over) aborts, `undefined` (the store did not answer) aborts only once the lease ran out
   * here — before that the caller's write goes on. Throws the holder's `ExecutionLeaseLostError` once
   * aborted.
   */
  settle(sentAt: SentAt, renewed: Milliseconds | false | undefined): void {
    this.lost.signal.throwIfAborted();
    if (renewed === false) this.lose();
    if (renewed !== undefined) {
      const next = deadlinesOf(sentAt, renewed, this.margin);
      this.#until = {
        monotonic: Math.max(this.#until.monotonic, next.monotonic),
        wall: Math.max(this.#until.wall, next.wall),
      };
    }
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
    if (!(left > 0)) {
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
): Promise<{ readonly sentAt: SentAt; readonly renewed: Milliseconds | false | undefined }> {
  const sentAt = sentAtOf(clock);
  const renewed = await repository.renew(held, EXECUTION_LEASE).then(
    (remaining) => remaining ?? false,
    (): undefined => undefined,
  );
  return { sentAt, renewed };
}
