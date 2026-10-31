// #543 AC1: storeConformance on a set with an opted-out outbound-call store, the opt-out not accepted.
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { UncheckedCalls } from "./broken-fencing-stores.js";

storeConformance({
  name: "an opt-out not accepted",
  stores: {
    executionLease: inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryExecutionLeaseRepository(clock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(
      ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
    ),
    fencedEffect: inMemoryTarget(inMemoryFencedEffects(false)),
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
