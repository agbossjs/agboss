// #526 AC1, AC2, #543 AC2: storeConformance on a set whose outbound-call store opts out of the atomic lease
// check (an atomic store with the flag stuck on), the opt-out accepted.
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { UncheckedCalls } from "./broken-fencing-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "an opted-out outbound-call store",
  acceptWithoutDoubleChargeProtection: true,
  stores: {
    executionLease: inMemoryTarget(
      ({ storeClock, application, database }) =>
        new InMemoryExecutionLeaseRepository(storeClock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(
      ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
    ),
    fencedEffect: inMemoryTarget(inMemoryFencedEffects(false)),
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
