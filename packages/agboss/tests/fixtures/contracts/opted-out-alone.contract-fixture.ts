// #543 acceptance: the outbound-call contract run alone on an opted-out store, the opt-out accepted.
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { outboundCallContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { UncheckedCalls } from "./broken-fencing-stores.js";

outboundCallContract(
  {
    ...inMemoryTarget((seam) => {
      const leases = new InMemoryExecutionLeaseRepository(
        seam.storeClock,
        seam.application,
        seam.database,
      );
      return { calls: new UncheckedCalls(seam.storeClock, seam.database, leases), leases };
    }),
    name: "an opted-out store run alone",
  },
  { acceptWithoutDoubleChargeProtection: true },
);
