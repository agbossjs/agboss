import { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import { TestSetupError } from "./errors.js";

/**
 * How one instance's clock is off (#533): its wall clock `offset` ms ahead (negative: behind) of the
 * test's time, and running `drift` faster (0.01 = 1 % fast, −0.01 = 1 % slow) — its wall time, its
 * monotonic time and its sleeps alike. `testWith(App, { instances: 2, clockSkews: [ClockSkew.none,
 * ClockSkew.ahead(seconds(300))] })`; the stores keep the test's own clock, as a database keeps its
 * own, so a skewed instance shows what its skew does to its leases.
 */
export class ClockSkew {
  /** No skew: the test's clock as it is. */
  static readonly none: ClockSkew = new ClockSkew(0, 0);

  private constructor(
    /** How far (ms) the instance's wall clock is ahead of the test's; negative: behind. */
    readonly offset: number,
    /** How much faster its clock runs: 0.01 = 1 % fast, −0.01 = 1 % slow. */
    readonly drift: number,
  ) {
    if (!Number.isFinite(offset)) throw new TestSetupError(`ClockSkew: offset ${String(offset)}`);
    if (!(Math.abs(drift) < 0.5))
      throw new TestSetupError(`ClockSkew: drift ${String(drift)} — a rate between −0.5 and 0.5`);
  }

  /** A wall clock `by` ahead of the test's. */
  static ahead(by: Milliseconds): ClockSkew {
    return new ClockSkew(by, 0);
  }

  /** A wall clock `by` behind the test's. */
  static behind(by: Milliseconds): ClockSkew {
    return new ClockSkew(0 - by, 0);
  }

  /** A clock that runs `rate` faster (0.01) or slower (−0.01) than the test's. */
  static drift(rate: number): ClockSkew {
    return new ClockSkew(0, rate);
  }

  /** This skew, its clock also running `rate` faster or slower. */
  andDrift(rate: number): ClockSkew {
    return new ClockSkew(this.offset, rate);
  }
}

/**
 * An instance's clock over the test's (#533): `skew.offset` ahead, `skew.drift` faster — what its
 * process reads as the wall time, as its monotonic time, and how long its sleeps last in the test's
 * time. Built at the test's current moment: the offset holds from then on, the drift accumulates.
 */
export class SkewedClock extends Clock {
  readonly #origin: number;
  readonly #monotonicOrigin: number;
  readonly #rate: number;

  constructor(
    private readonly base: Clock,
    private readonly skew: ClockSkew,
  ) {
    super();
    this.#origin = base.now().getTime();
    this.#monotonicOrigin = base.monotonicNow();
    this.#rate = 1 + skew.drift;
  }

  now(): Date {
    const elapsed = this.base.now().getTime() - this.#origin;
    return new Date(this.#origin + this.skew.offset + elapsed * this.#rate);
  }

  override monotonicNow(): number {
    const elapsed = this.base.monotonicNow() - this.#monotonicOrigin;
    return this.#monotonicOrigin + elapsed * this.#rate;
  }

  /** `delay` of this clock's time: shorter in the test's time when it runs fast. */
  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return this.base.sleep((delay / this.#rate) as Milliseconds, signal);
  }
}
