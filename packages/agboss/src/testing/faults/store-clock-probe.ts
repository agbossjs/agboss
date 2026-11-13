import type { App } from "../../app/types.js";
import { systemClock } from "../../infrastructure/clock.js";
import { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { waitOf } from "../../infrastructure/clock.js";
import { FaultStoreTime, storeTimeScaleOf } from "./fault-stores.js";
import type { FaultPod } from "./pod.js";

/**
 * #959 AC1 — the store's clock rate is measured, not trusted: a pod takes two leases a real wait
 * apart and reads the two expiries off the store (`expiresAt = the store's now + duration`), so the
 * difference of the expiries is how much store time passed while `realMs` of real time did. A
 * store set whose `storeTime` contradicts that rate fails the suite with a named reason — a wrong
 * but valid declaration would map the history on the wrong time and read green.
 */

/** The root execution ids of the probe's leases: its operations are kept out of the run's history. */
export const CLOCK_PROBE_KEY_PREFIX = "fault-clock-probe-";

/** Whether a history event's key is a probe lease's. */
export const isClockProbeKey = (key: string | undefined): boolean =>
  key?.startsWith(CLOCK_PROBE_KEY_PREFIX) === true;

/** How long the store's time ran, against how long real time did. */
export interface StoreClockReading {
  readonly storeMs: number;
  readonly realMs: number;
}

/** A store set whose declared `storeTime` contradicts the clock rate its stores measured (#959). */
export class FaultStoreTimeMismatchError extends Error {
  override name = "FaultStoreTimeMismatchError";

  constructor(declared: FaultStoreTime, reading: StoreClockReading, timeScale: number) {
    const other =
      declared === FaultStoreTime.Database ? FaultStoreTime.Host : FaultStoreTime.Database;
    super(
      `[fault-suite.store-time-mismatch] the store set declares storeTime ${JSON.stringify(declared)}, but its stores' clock ran ${String(reading.storeMs)} ms while ${String(reading.realMs)} ms of real time passed (the pods' timeScale is ${String(timeScale)}): that is not the rate of FaultStoreTime.${declared === FaultStoreTime.Database ? "Database" : "Host"} (${String(storeTimeScaleOf(declared, timeScale))}x) but of ${JSON.stringify(other)} (${String(storeTimeScaleOf(other, timeScale))}x) — declare the time the fencing stores decide by`,
    );
  }
}

/** The real wait of the probe: long enough that the two rates differ by more than a round trip. */
export const probeWaitOf = (timeScale: number): number =>
  timeScale <= 1 ? 0 : Math.ceil(Math.min(3000, Math.max(300, 200 / (timeScale - 1))));

const realNow = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** Takes two probe leases `waitMs` of real time apart and reads how far the store's time moved. */
export async function readStoreClock(app: App, waitMs: number): Promise<StoreClockReading> {
  const leases = app.resolve(ExecutionLeaseRepository);
  const duration = waitOf(60_000);
  const first = await leases.acquire("default", `${CLOCK_PROBE_KEY_PREFIX}1`, duration);
  const started = realNow();
  await systemClock.sleep(waitOf(waitMs));
  const second = await leases.acquire("default", `${CLOCK_PROBE_KEY_PREFIX}2`, duration);
  const realMs = realNow() - started;
  if (first === undefined || second === undefined)
    throw new Error("the store refused a lease of a key nobody held: the clock was not read");
  await Promise.all([leases.release(first), leases.release(second)]);
  return { storeMs: second.expiresAt.getTime() - first.expiresAt.getTime(), realMs };
}

/** A reading from a pod's reply, or why it is none. */
export function readingOf(value: unknown): StoreClockReading {
  const storeMs: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "storeMs") : undefined;
  const realMs: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "realMs") : undefined;
  if (typeof storeMs !== "number" || typeof realMs !== "number" || realMs <= 0)
    throw new TypeError(
      `a store clock reading is { storeMs, realMs }, got ${JSON.stringify(value)}`,
    );
  return { storeMs, realMs };
}

/**
 * Refuses a declaration the reading contradicts: the rate it shows is nearer (in ratio) the other
 * time's than the declared one's. At a timeScale of 1 the two times are the same rate — nothing to
 * contradict.
 */
export function checkStoreTime(
  declared: FaultStoreTime,
  reading: StoreClockReading,
  timeScale: number,
): void {
  if (timeScale <= 1) return;
  const rate = reading.storeMs / reading.realMs;
  const other =
    declared === FaultStoreTime.Database ? FaultStoreTime.Host : FaultStoreTime.Database;
  const distance = (time: FaultStoreTime): number =>
    Math.abs(Math.log(rate / storeTimeScaleOf(time, timeScale)));
  if (!(rate > 0) || distance(other) < distance(declared))
    throw new FaultStoreTimeMismatchError(declared, reading, timeScale);
}

/** The pod's stores' clock measured and its set's `storeTime` checked against it (#959). */
export async function probedStoreTime(pod: FaultPod, timeScale: number): Promise<void> {
  if (pod.storeTime === undefined || timeScale <= 1) return;
  const reading = readingOf(
    await pod.command({ op: "probe-store-clock", wait: probeWaitOf(timeScale) }),
  );
  checkStoreTime(pod.storeTime, reading, timeScale);
}
