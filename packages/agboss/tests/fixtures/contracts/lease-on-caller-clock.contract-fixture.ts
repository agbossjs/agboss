// #533: the lease contract against a lease store that decides expiry by the caller's clock (`seam.clock`,
// what @agboss/postgres did before #533) instead of the store's (`seam.storeClock`).
import { executionLeaseContract } from "../../../src/testing/contracts/index.js";
import { LeaseTable, MapExecutionLeaseRepository } from "./map-lease-store.js";

let table = new LeaseTable();

executionLeaseContract({
  name: "a lease store on the caller's clock",
  reset: () => {
    table = new LeaseTable();
  },
  instance: (seam) => new MapExecutionLeaseRepository(table, seam.clock, seam.application),
});
