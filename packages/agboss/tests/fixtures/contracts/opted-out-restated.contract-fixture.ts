// #543 acceptance: storeConformance on an outbound-call store whose leaseCheck comes from its class chain (RestatedAtomicCalls).
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { RestatedAtomicCalls } from "./opted-out-subclass-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "an atomic check restated, the flag set",
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
      return { calls: new RestatedAtomicCalls(seam.storeClock, seam.database, leases), leases };
    }),
  },
});
