// #543 AC1, AC2: storeConformance on a set whose fenced-effect store really checks the lease, then
// writes, and says so (LeaseCheck.WithoutDoubleChargeProtection), the opt-out accepted.
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { brokenEffects, UncheckedCalls } from "./broken-fencing-stores.js";
import { OptedOutCheckThenWriteEffects } from "./opted-out-stores.js";

storeConformance({
  name: "an honest check-then-write store",
  acceptWithoutDoubleChargeProtection: true,
  stores: {
    executionLease: inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryExecutionLeaseRepository(clock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(
      ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
    ),
    fencedEffect: inMemoryTarget(brokenEffects(OptedOutCheckThenWriteEffects)),
    outboundCall: inMemoryTarget((seam) => {
      const leases = new InMemoryExecutionLeaseRepository(
        seam.clock,
        seam.application,
        seam.database,
      );
      return { calls: new UncheckedCalls(seam.clock, seam.database, leases), leases };
    }),
  },
});
