import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import type { OutboundCallStores } from "../../../src/testing/contracts/index.js";
import type { StoreFactory } from "./store-kinds.js";

/** The core's outbound-call stores as targets of the published outbound-call contract (#505). */

/** The in-memory store over the test's database, beside the in-memory leases it checks. */
export const inMemoryOutboundCalls: StoreFactory<OutboundCallStores> = (seam) => {
  const leases = new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database);
  return {
    calls: new InMemoryOutboundCallRepository(seam.clock, seam.database, leases),
    leases,
  };
};
