// #526 AC3: storeConformance on a set whose fenced-effect store checks the lease without a lock and not again at its commit (#695).
import { InMemoryExecutionAuditLogRepository } from "../../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { unlockedCheckEffects } from "./broken-hand-over-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "effects whose lease check takes no lock",
  stores: {
    executionLease: inMemoryTarget(
      ({ storeClock, application, database }) =>
        new InMemoryExecutionLeaseRepository(storeClock, application, database),
    ),
    executionAuditLog: inMemoryTarget(
      ({ database }) => new InMemoryExecutionAuditLogRepository(database),
    ),
    fencedEffect: inMemoryTarget(unlockedCheckEffects),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});
