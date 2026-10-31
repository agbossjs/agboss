// #526 AC3: storeConformance on a set whose fenced-effect store writes its rows outside its transaction.
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { brokenEffects, RowsOutsideEffects } from "./broken-fencing-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "rows outside the transaction",
  stores: {
    executionLease: inMemoryTarget(
      ({ storeClock, application, database }) =>
        new InMemoryExecutionLeaseRepository(storeClock, application, database),
    ),
    executionLeaseEvent: inMemoryTarget(
      ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
    ),
    fencedEffect: inMemoryTarget(brokenEffects(RowsOutsideEffects)),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});
