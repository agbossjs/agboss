import type { AnyTenantApp } from "../../app/types.js";
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

/**
 * How long the store's time ran, against how long real time did. The store read its two times
 * somewhere inside the real calls, so the real time that passed between them is not one number but
 * a bracket: at least `realMs` (from the end of the first call to the start of the second) and at
 * most `bracketMs` (from the start of the first to the end of the second). A loaded host widens the
 * bracket by exactly the scheduling delay it measured; `bracketMs` is `realMs` for a reading taken
 * without one.
 */
export interface StoreClockReading {
  readonly storeMs: number;
  readonly realMs: number;
  readonly bracketMs?: number;
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
export async function readStoreClock(
  app: AnyTenantApp,
  waitMs: number,
): Promise<StoreClockReading> {
  const leases = app.resolve(ExecutionLeaseRepository);
  const duration = waitOf(60_000);
  const begun = realNow();
  const first = await leases.acquire("default", `${CLOCK_PROBE_KEY_PREFIX}1`, duration);
  const started = realNow();
  await systemClock.sleep(waitOf(waitMs));
  const resumed = realNow();
  const second = await leases.acquire("default", `${CLOCK_PROBE_KEY_PREFIX}2`, duration);
  const ended = realNow();
  // the store read its first time before `started` and its second after `resumed`
  const realMs = resumed - started;
  const bracketMs = ended - begun;
  if (first === undefined || second === undefined)
    throw new Error("the store refused a lease of a key nobody held: the clock was not read");
  await Promise.all([leases.release(first), leases.release(second)]);
  return { storeMs: second.expiresAt.getTime() - first.expiresAt.getTime(), realMs, bracketMs };
}

/** A field of a pod's reply, whatever the reply is. */
const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** A reading from a pod's reply, or why it is none. */
export function readingOf(value: unknown): StoreClockReading {
  const storeMs = fieldOf(value, "storeMs");
  const realMs = fieldOf(value, "realMs");
  const bracketMs = fieldOf(value, "bracketMs");
  if (typeof storeMs !== "number" || typeof realMs !== "number" || realMs <= 0)
    throw new TypeError(
      `a store clock reading is { storeMs, realMs }, got ${JSON.stringify(value)}`,
    );
  return typeof bracketMs === "number" && bracketMs >= realMs
    ? { storeMs, realMs, bracketMs }
    : { storeMs, realMs };
}

/**
 * Refuses a declaration the reading contradicts: the store's time ran nearer (in ratio) to the span
 * the other time predicts than to the declared one's. Each time predicts a span, not a point: the
 * real time between the store's two reads is somewhere in the reading's bracket, and the pods' time
 * runs `timeScale` times that. Where a loaded host stretched the bracket until the two spans meet,
 * the reading cannot tell them apart and contradicts nothing. At a timeScale of 1 the two times are
 * the same rate — nothing to contradict.
 */
export function checkStoreTime(
  declared: FaultStoreTime,
  reading: StoreClockReading,
  timeScale: number,
): void {
  if (timeScale <= 1) return;
  const other =
    declared === FaultStoreTime.Database ? FaultStoreTime.Host : FaultStoreTime.Database;
  const bracketMs = reading.bracketMs ?? reading.realMs;
  /** How far (in ratio) the store's time is from the span `time` predicts: 0 inside it. */
  const distance = (time: FaultStoreTime): number => {
    const scale = storeTimeScaleOf(time, timeScale);
    const lowest = reading.realMs * scale;
    const highest = bracketMs * scale;
    if (reading.storeMs >= lowest && reading.storeMs <= highest) return 0;
    return Math.abs(Math.log(reading.storeMs / (reading.storeMs < lowest ? lowest : highest)));
  };
  if (!(reading.storeMs > 0) || distance(other) < distance(declared))
    throw new FaultStoreTimeMismatchError(declared, reading, timeScale);
}

/** The clusters whose first pod was probed. */
const probed = new WeakSet<object>();

/**
 * The first pod of `cluster` measures its stores' clock and its set's `storeTime` is checked
 * against it (#959), and gives the pod back; later pods of the cluster, and a run at the real clock, are not probed.
 */
export async function probedStoreTime(
  cluster: { readonly options: { readonly timeScale: number } },
  pod: FaultPod,
): Promise<FaultPod> {
  const { timeScale } = cluster.options;
  if (probed.has(cluster) || pod.storeTime === undefined || timeScale <= 1) return pod;
  probed.add(cluster);
  const reading = readingOf(
    await pod.command({ op: "probe-store-clock", wait: probeWaitOf(timeScale) }),
  );
  checkStoreTime(pod.storeTime, reading, timeScale);
  return pod;
}
