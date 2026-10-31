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

/** A time scale from text: a number from 1; anything else is a `RangeError`. */
export function timeScaleOf(text: string | undefined): number {
  if (text === undefined || text === "") return 1;
  const scale = Number(text);
  if (!Number.isFinite(scale) || scale < 1)
    throw new RangeError(`the fault suite's time scale is a number from 1, got ${text}`);
  return scale;
}

/** The real time run `scale` times faster from `origin` (ms since the epoch). */
export class ScaledClock extends Clock {
  constructor(
    readonly scale: number,
    readonly origin: number,
    private readonly real: Clock = systemClock,
  ) {
    super();
  }

  now(): Date {
    const real = this.real.now().getTime();
    return new Date(this.origin + (real - this.origin) * this.scale);
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return this.real.sleep(waitOf(delay / this.scale), signal);
  }
}

/** The clock of a fault pod: its scale and origin from its environment. */
@Injectable()
export class FaultPodClock extends ScaledClock {
  constructor() {
    const origin = Number(process.env[TIME_ORIGIN_VARIABLE] ?? "");
    super(
      timeScaleOf(process.env[TIME_SCALE_VARIABLE]),
      Number.isFinite(origin) && origin > 0 ? origin : systemClock.now().getTime(),
    );
  }
}
