import { StoreClock, StoreTimeSource, type Clock } from "../../src/infrastructure/clock.js";

/** A test's store clock on `clock` (G7): what a store built by hand in a test decides expiry by. */
export const storeClockOf = (clock: Pick<Clock, "now">): StoreClock =>
  new StoreClock(StoreTimeSource.Test, clock);

/**
 * A store clock on the calling instance's own clock (`StoreTimeSource.Host`): the design before
 * #533 a sabotage restores, so the store's time is no longer one for every instance.
 */
export const callerStoreClockOf = (clock: Pick<Clock, "now">): StoreClock =>
  new StoreClock(StoreTimeSource.Host, clock);
