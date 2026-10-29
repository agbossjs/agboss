// #481 AC2: the lease contract against a lease store whose `acquire` ignores a valid holder.
import { executionLeaseContract } from "../../../src/testing/contracts/index.js";
import { HolderIgnoringLeaseRepository } from "./broken-stores.js";
import { LeaseTable } from "./map-lease-store.js";

let table = new LeaseTable();

executionLeaseContract({
  name: "a lease store that ignores a valid holder",
  reset: () => {
    table = new LeaseTable();
  },
  instance: (seam) => new HolderIgnoringLeaseRepository(table, seam.clock, seam.application),
});
