// #526 AC6: storeConformance on a set whose lease log keeps the row schema of before #508.
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { PreSupersedeLeaseLog } from "./broken-fencing-stores.js";

storeConformance({
  name: "a lease log of before #508",
  stores: {
    executionLease: inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryExecutionLeaseRepository(clock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(({ database }) => new PreSupersedeLeaseLog(database)),
    fencedEffect: inMemoryTarget(inMemoryFencedEffects(false)),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});
