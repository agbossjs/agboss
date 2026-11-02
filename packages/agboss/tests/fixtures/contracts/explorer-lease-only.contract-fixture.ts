// #694: the interleaving explorer on a lease store alone (a set of coordination stores, `without`
// its fenced-effect and outbound-call stores): the sound in-memory store, and two broken ones.
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../../src/infrastructure/execution-lease.repository.js";
import { registerInterleavings } from "../../../src/testing/contracts/explorer/register.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

const BUDGET = { depth: 6, walks: 20, walkDepth: 20 };

/** A lease store whose `finish` only releases: finished work is taken again (#520). */
class ReleasingFinishLeaseRepository extends InMemoryExecutionLeaseRepository {
  override finish(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

registerInterleavings(
  "leases alone",
  {
    executionLease: inMemoryTarget(
      (seam) =>
        new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database),
    ),
  },
  BUDGET,
);
registerInterleavings(
  "leases alone on the caller's clock",
  {
    executionLease: inMemoryTarget(
      (seam) => new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database),
    ),
  },
  BUDGET,
);
registerInterleavings(
  "leases alone, a finish that only releases",
  {
    executionLease: inMemoryTarget(
      (seam) =>
        new ReleasingFinishLeaseRepository(seam.storeClock, seam.application, seam.database),
    ),
  },
  BUDGET,
);
// no lease store, no fencing store: still nothing to explore
registerInterleavings("no stores", {}, BUDGET);
