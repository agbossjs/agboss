// #959: storeConformance on a set whose open fenced write holds off a release but not the take of an expired lease.
import { InMemoryExecutionAuditLogRepository } from "../../../src/infrastructure/execution-audit-log.repository.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { releaseLockedEffects, releaseLockedLeases } from "./broken-expiry-hand-over-stores.js";
import { FIXTURE_INTERLEAVINGS } from "./fixture-budget.js";

storeConformance({
  interleavings: FIXTURE_INTERLEAVINGS,
  name: "an open write that locks a release, not an expiry",
  stores: {
    executionLease: inMemoryTarget(releaseLockedLeases),
    executionAuditLog: inMemoryTarget(
      ({ database }) => new InMemoryExecutionAuditLogRepository(database),
    ),
    fencedEffect: inMemoryTarget(releaseLockedEffects),
    outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  },
});
