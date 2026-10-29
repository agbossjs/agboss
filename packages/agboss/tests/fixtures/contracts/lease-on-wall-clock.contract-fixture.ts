// #481: the lease contract against a lease store that reads Date.now() instead of the seam's clock.
import { executionLeaseContract } from "../../../src/testing/contracts/index.js";
import { WallClockLeaseRepository } from "./broken-stores.js";
import { LeaseTable } from "./map-lease-store.js";

let table = new LeaseTable();

executionLeaseContract({
  name: "a lease store on the wall clock",
  reset: () => {
    table = new LeaseTable();
  },
  instance: (seam) => new WallClockLeaseRepository(table, seam.clock, seam.application),
});
