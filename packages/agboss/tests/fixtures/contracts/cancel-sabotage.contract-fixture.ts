// #909 AC2: the contracts and the interleaving explorer on fencing stores whose cancel fence is broken.
import { InMemoryExecutionAuditLogRepository } from "../../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { prunedByAge } from "./cancel-age-pruning-stores.js";
import { cancelReadBefore, withoutCancelFence } from "./cancel-broken-stores.js";

const BUDGET = { depth: 7, walks: 30, walkDepth: 20 } as const;

const leases = inMemoryTarget(
  ({ storeClock, application, database }) =>
    new InMemoryExecutionLeaseRepository(storeClock, application, database),
);
const audit = inMemoryTarget(({ database }) => new InMemoryExecutionAuditLogRepository(database));

storeConformance({
  interleavings: BUDGET,
  name: "stores with no cancel check",
  stores: {
    executionLease: leases,
    executionAuditLog: audit,
    fencedEffect: inMemoryTarget(withoutCancelFence.effects),
    outboundCall: inMemoryTarget(withoutCancelFence.calls),
  },
});

storeConformance({
  interleavings: BUDGET,
  name: "effects reading the cancel before the transaction",
  stores: {
    executionLease: leases,
    executionAuditLog: audit,
    fencedEffect: inMemoryTarget(cancelReadBefore),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});

storeConformance({
  interleavings: BUDGET,
  name: "a retention that lifts the cancel's mark by age alone",
  stores: {
    executionLease: leases,
    executionAuditLog: audit,
    fencedEffect: inMemoryTarget(prunedByAge.effects),
    outboundCall: inMemoryTarget(prunedByAge.calls),
  },
});
