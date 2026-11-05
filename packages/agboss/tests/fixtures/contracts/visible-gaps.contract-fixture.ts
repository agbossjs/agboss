// #799: what a store set does not check is shown, never passed — an explorer turned off, a fencing
// set explored below the floor (or not at all), the contracts it does not claim, an optional method
// its store lacks. tests/testing/contracts/visible-gaps.test.ts reads the cases.
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryStores } from "../../infrastructure/contracts/core-store-sets.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { NotifyingQueueRepository } from "./broken-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

const { executionLease, executionLeaseEvent, fencedEffect, outboundCall } = inMemoryStores();
const FENCING = { executionLease, executionLeaseEvent, fencedEffect, outboundCall };

storeConformance({
  name: "leases alone, explorer off",
  stores: { executionLease },
  without: ["fencedEffect", "outboundCall", "executionLeaseEvent"],
  interleavings: false,
});
storeConformance({ name: "fencing, explorer off", stores: FENCING, interleavings: false });
storeConformance({
  name: "fencing, below the floor",
  stores: FENCING,
  interleavings: { depth: 3, walks: 5, walkDepth: 8 },
});
storeConformance({
  name: "fencing, at the floor",
  stores: FENCING,
  interleavings: FIXTURE_INTERLEAVINGS,
});
storeConformance({
  name: "a queue without a watch",
  stores: {
    childExecutionQueue: inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryChildExecutionQueueRepository(clock, application, database),
    ),
  },
});
let built = 0;
storeConformance({
  name: "a queue watched on one instance only",
  stores: {
    childExecutionQueue: inMemoryTarget(({ clock, application, database }) => {
      built += 1;
      return built % 2 === 1
        ? new NotifyingQueueRepository(clock, application, database)
        : new InMemoryChildExecutionQueueRepository(clock, application, database);
    }),
  },
});
