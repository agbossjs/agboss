import { RENEW_EVERY } from "../../src/app/lease-fence.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";

/**
 * Lets `duration` pass for a live process: the clock moves in steps of at most a renewal interval,
 * so every lease renewal reaches its store in time. One `clock.advance` of a whole lease or more is
 * a holder frozen that long — past its expiry its lease is over, taken or not (#534).
 */
export async function passLive(clock: VirtualClock, duration: Milliseconds): Promise<void> {
  let left: number = duration;
  while (left > 0) {
    const step = Math.min(left, RENEW_EVERY);
    await clock.advance(seconds(step / 1000));
    left -= step;
  }
}
