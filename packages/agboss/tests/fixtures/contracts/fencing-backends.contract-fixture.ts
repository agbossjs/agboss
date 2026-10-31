// #526 AC1, AC2: storeConformance on a set whose stores declare no backend, or another than their leases'.
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { ElsewhereEffects, UndeclaredCalls, UndeclaredLeases } from "./broken-fencing-stores.js";

storeConformance({
  name: "stores of no backend or another",
  stores: {
    executionLease: inMemoryTarget(
      ({ clock, application, database }) => new UndeclaredLeases(clock, application, database),
    ),
    fencedEffect: inMemoryTarget((seam) => {
      const stores = inMemoryFencedEffects(false)(seam);
      const settings = new FencedEffectSettings();
      const effects = new ElsewhereEffects(seam.clock, seam.database, settings, stores.leases);
      return { ...stores, effects };
    }),
    outboundCall: inMemoryTarget((seam) => {
      const leases = new InMemoryExecutionLeaseRepository(
        seam.clock,
        seam.application,
        seam.database,
      );
      return { calls: new UndeclaredCalls(seam.clock, seam.database, leases), leases };
    }),
  },
  without: ["executionLeaseEvent"],
});
