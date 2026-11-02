// #481 AC2: the lease contract against a lease store whose `acquire` checks, then writes (#695).
import { executionLeaseContract } from "../../../src/testing/contracts/index.js";
import { CheckThenWriteLeaseRepository } from "./broken-stores.js";
import { LeaseTable } from "./map-lease-store.js";

let table = new LeaseTable();

executionLeaseContract({
  name: "a lease store that checks, then writes",
  reset: () => {
    table = new LeaseTable();
  },
  instance: (seam) => new CheckThenWriteLeaseRepository(table, seam.storeClock, seam.application),
});
