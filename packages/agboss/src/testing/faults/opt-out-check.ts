import type { FaultScenarioOptions } from "./scenario.js";
import { FaultWorld } from "./world.js";

/**
 * #584 — the fault suite proves nothing for payments on a set that opts out of the atomic lease
 * check (`LeaseCheck.WithoutDoubleChargeProtection`, #543): its scenarios may pass, since no race
 * of theirs hits the gap, so the suite says so itself — one case, failing for such a set and naming
 * its stores, read from a pod (the store set's module is loaded where the pods load it).
 */

/** The case `faultSuite` registers before its scenarios. */
export const ATOMIC_FENCING_CASE =
  "fences atomically: no store declares LeaseCheck.WithoutDoubleChargeProtection";

/** A store set under the fault suite opts out of the atomic lease check. */
export class FaultSuiteOptedOutError extends Error {
  override name = "FaultSuiteOptedOutError";

  constructor(readonly stores: readonly string[]) {
    super(
      `[fault-suite.opted-out-store] ${stores.join(", ")} declare${stores.length === 1 ? "s" : ""} LeaseCheck.WithoutDoubleChargeProtection: a holder whose lease was taken over can still write, so the set protects no payment — whatever its fault scenarios show`,
    );
  }
}

/** Starts one pod on the set and refuses it when a store of it opts out. */
export async function checkAtomicFencing(options: FaultScenarioOptions): Promise<void> {
  await options.database.reset?.();
  const world = new FaultWorld({
    stores: options.stores,
    database: options.database,
    timeScale: options.timeScale ?? 1,
  });
  let optedOut: readonly string[];
  try {
    optedOut = (await world.pod("a")).optedOut;
  } finally {
    await world.close();
  }
  if (optedOut.length > 0) throw new FaultSuiteOptedOutError(optedOut);
}
