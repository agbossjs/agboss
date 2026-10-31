import { Injectable } from "../../components/decorators.js";
import { Clock, systemClock } from "../../infrastructure/clock.js";
import { waitOf } from "../../infrastructure/clock.js";
import type { Milliseconds } from "../../units/index.js";

/**
 * The clock of a fault pod (#484): the real time, run `scale` times faster from one origin that
 * every pod of a run shares — so the pods agree on every expiry, and a lease of 30 s lasts
 * 30 s / `scale` of real time. Scale 1 is the system's time itself. Read from the pod's
 * environment (`AGBOSS_FAULT_TIME_SCALE`, `AGBOSS_FAULT_TIME_ORIGIN`), set by the suite.
 */

/** The environment variables a pod's clock reads. */
export const TIME_SCALE_VARIABLE = "AGBOSS_FAULT_TIME_SCALE";
export const TIME_ORIGIN_VARIABLE = "AGBOSS_FAULT_TIME_ORIGIN";
/** A pod whose clock is off (#533): its wall clock this many ms ahead (negative: behind). */
export const CLOCK_OFFSET_VARIABLE = "AGBOSS_FAULT_CLOCK_OFFSET_MS";
/** …and running this much faster (0.01: 1 % fast, −0.01: 1 % slow). */
export const CLOCK_DRIFT_VARIABLE = "AGBOSS_FAULT_CLOCK_DRIFT";

/** A time scale from text: a number from 1; anything else is a `RangeError`. */
export function timeScaleOf(text: string | undefined): number {
  if (text === undefined || text === "") return 1;
  const scale = Number(text);
  if (!Number.isFinite(scale) || scale < 1)
    throw new RangeError(`the fault suite's time scale is a number from 1, got ${text}`);
  return scale;
}

/** How a pod's clock is off (#533): `offset` ms ahead (negative: behind), running `drift` faster. */
export interface PodClockSkew {
  readonly offset: number;
  readonly drift: number;
}

const NO_SKEW: PodClockSkew = { offset: 0, drift: 0 };

/**
 * The real time run `scale` times faster from `origin` (ms since the epoch) — and, for a pod whose
 * clock is off (#533), `skew.offset` ahead and `skew.drift` faster: its wall time, its monotonic time
 * (the real monotonic clock, scaled the same way) and its sleeps.
 */
export class ScaledClock extends Clock {
  readonly #monotonicOrigin: number;
  readonly #rate: number;

  constructor(
    readonly scale: number,
    readonly origin: number,
    private readonly real: Clock = systemClock,
    readonly skew: PodClockSkew = NO_SKEW,
  ) {
    super();
    this.#rate = scale * (1 + skew.drift);
    this.#monotonicOrigin = real.monotonicNow();
  }

  now(): Date {
    const real = this.real.now().getTime();
    return new Date(this.origin + this.skew.offset + (real - this.origin) * this.#rate);
  }

  override monotonicNow(): number {
    return (this.real.monotonicNow() - this.#monotonicOrigin) * this.#rate;
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return this.real.sleep(waitOf(delay / this.#rate), signal);
  }
}

const numberOf = (text: string | undefined): number => {
  const value = Number(text ?? "0");
  return Number.isFinite(value) ? value : 0;
};

/** A pod's scale and origin from its environment. */
const podTime = (): { readonly scale: number; readonly origin: number } => {
  const origin = Number(process.env[TIME_ORIGIN_VARIABLE] ?? "");
  return {
    scale: timeScaleOf(process.env[TIME_SCALE_VARIABLE]),
    origin: Number.isFinite(origin) && origin > 0 ? origin : systemClock.now().getTime(),
  };
};

/**
 * The run's time as the database sees it (#533): the pod's scale and origin, never its skew — what
 * the pod's stores decide a lease's expiry by (`StoreClock`), as a database's clock would be.
 */
export const hostClockOfPod = (): ScaledClock => {
  const { scale, origin } = podTime();
  return new ScaledClock(scale, origin);
};

/** The clock of a fault pod: its scale and origin, and its skew, from its environment. */
@Injectable()
export class FaultPodClock extends ScaledClock {
  constructor() {
    const { scale, origin } = podTime();
    super(scale, origin, systemClock, {
      offset: numberOf(process.env[CLOCK_OFFSET_VARIABLE]),
      drift: numberOf(process.env[CLOCK_DRIFT_VARIABLE]),
    });
  }
}
