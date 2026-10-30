import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
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

/** The SQLite store on this instance's connection to the test's file, with its lease store. */
export const sqliteOutboundCalls: StoreFactory<OutboundCallStores> = (seam) => {
  const connection = seam.connection();
  return {
    calls: new SqliteOutboundCallRepository(connection, seam.clock),
    leases: new SqliteExecutionLeaseRepository(connection, seam.clock, seam.application),
  };
};
