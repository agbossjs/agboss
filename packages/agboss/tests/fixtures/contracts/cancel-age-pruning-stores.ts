/**
 * #909: fencing stores whose retention lifts a cancel's mark by age alone (the way a port that
 * prunes `requested_at < cutoff` gets it wrong): they see every lease as retired, so the sweep
 * removes the mark of a tree that is not over, and its next write lands after the cancel.
 */
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  InMemoryFencedEffectRepository,
  type InMemoryFencedEffectTransaction,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import type { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import type {
  FencedEffectTarget,
  OutboundCallTarget,
} from "../../../src/testing/contracts/index.js";
import type { InstanceSeam, StoreFactory } from "../../infrastructure/contracts/store-kinds.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";

/** `database` as the retention sweeps see it: every tree's lease retired — a sweep by age alone. */
const everyLeaseRetired = (database: InMemoryDatabase): InMemoryDatabase =>
  new Proxy(database, {
    get: (target, property) => {
      if (property !== "executionLeases") return Reflect.get(target, property, target) as unknown;
      return new Proxy(target.executionLeases, {
        get: (leases, method) => {
          if (method !== "get") {
            const value = Reflect.get(leases, method, leases) as unknown;
            return typeof value === "function"
              ? (value as (...args: unknown[]) => unknown).bind(leases)
              : value;
          }
          return (key: string) => {
            const stored = leases.get(key);
            return stored === undefined ? undefined : { ...stored, isRetired: true };
          };
        },
      });
    },
  });

const leasesOf = (seam: InstanceSeam) =>
  new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database);

/** The in-memory stores of the core whose sweeps lift the mark by age alone. */
export const prunedByAge = {
  effects: ((seam: InstanceSeam) => {
    const built = inMemoryFencedEffects(false)(seam);
    const leases = leasesOf(seam);
    return {
      ...built,
      effects: new InMemoryFencedEffectRepository(
        seam.storeClock,
        everyLeaseRetired(seam.database),
        new FencedEffectSettings(),
        leases,
      ),
      leases,
    };
  }) satisfies StoreFactory<FencedEffectTarget<InMemoryFencedEffectTransaction>>,
  calls: ((seam: InstanceSeam) => {
    const built = inMemoryOutboundCalls(seam);
    const leases = leasesOf(seam);
    return {
      ...built,
      calls: new InMemoryOutboundCallRepository(
        seam.storeClock,
        everyLeaseRetired(seam.database),
        leases,
      ),
      leases,
    };
  }) satisfies StoreFactory<OutboundCallTarget>,
};
