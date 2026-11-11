// #526 AC6: storeConformance on a set whose audit log keeps the row schema of before #508.
import { InMemoryExecutionAuditLogRepository } from "../../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { PreSupersedeLeaseLog } from "./broken-fencing-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "a audit log of before #508",
  stores: {
    executionLease: inMemoryTarget(
      ({ storeClock, application, database }) =>
        new InMemoryExecutionLeaseRepository(storeClock, application, database),
    ),
    executionAuditLog: inMemoryTarget(({ database }) => new PreSupersedeLeaseLog(database)),
    fencedEffect: inMemoryTarget(inMemoryFencedEffects(false)),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});
