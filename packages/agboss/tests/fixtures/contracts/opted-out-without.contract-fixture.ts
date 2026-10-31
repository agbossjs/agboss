// #543 acceptance: the opt-out accepted on a set that leaves the fenced-effect contract out (without).
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { UncheckedCalls } from "./broken-fencing-stores.js";

storeConformance({
  name: "an opt-out accepted, fenced effects left out",
  acceptWithoutDoubleChargeProtection: true,
  without: ["fencedEffect"],
  stores: {
    executionLease: inMemoryTarget(
      ({ storeClock, application, database }) =>
        new InMemoryExecutionLeaseRepository(storeClock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(
      ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
    ),
    outboundCall: inMemoryTarget((seam) => {
      const leases = new InMemoryExecutionLeaseRepository(
        seam.storeClock,
        seam.application,
        seam.database,
      );
      return { calls: new UncheckedCalls(seam.storeClock, seam.database, leases), leases };
    }),
  },
});
