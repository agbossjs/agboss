/**
 * #533 item 1, AC1: naive fencing stores the interleaving explorer must catch, each wrong in one way
 * a port to another database gets wrong between two operations — and the store targets that build
 * them. `explorer-bites.contract-fixture.ts` runs the explorer on each; `explorer-bites.test.ts`
 * reads which invariant each one broke.
 */
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryFencedEffectRepository } from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  InMemoryOutboundCallRepository,
  type OutboundCallClaim,
  type OutboundCallState,
} from "../../../src/infrastructure/outbound-call.repository.js";
import type { FencedEffectKey } from "../../../src/infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../../../src/units/index.js";
import type {
  ContractTarget,
  FencedEffectStores,
  OutboundCallStores,
} from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget, type InstanceSeam } from "../../infrastructure/contracts/store-kinds.js";
import {
  NaiveExpiryLeaseRepository,
  throughExpiry,
  holderAndEpochOnly,
  FromOldEndLeaseRepository,
} from "./naive-expiry.js";
import { currentToken, rewritingKeys, stepOnly } from "./naive-guarantees.js";

/** A lease store whose `finish` only releases: finished work is taken again (#520). */
class ReleasingFinishLeaseRepository extends InMemoryExecutionLeaseRepository {
  override finish(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

/** A lease store whose `reclaim` keeps the epoch: two grants of one epoch. */
class SameEpochReclaimLeaseRepository extends InMemoryExecutionLeaseRepository {
  override async reclaim(
    lease: ExecutionLease,
    length: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.reclaim(lease, length);
    return taken === undefined ? undefined : { ...taken, leaseEpoch: lease.leaseEpoch };
  }
}

/** An outbound-call store whose `markPending` does not compare: every claimer wins. */
class UncomparedOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async markPending(
    key: FencedEffectKey,
    _expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    const found = await this.findByKey(key);
    return found === undefined
      ? false
      : super.markPending(
          key,
          { status: found.status, attempt: found.attempt, attemptOwner: found.attemptOwner },
          claim,
        );
  }
}

/** The leases each broken target is built on. */
type LeasesOf = (seam: InstanceSeam) => InMemoryExecutionLeaseRepository;

const onStoreTime: LeasesOf = (seam) =>
  new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database);

/** An outbound-call target on `leasesOf`'s leases, its calls made by `callsOf`. */
const callsOn = (
  leasesOf: LeasesOf,
  callsOf: (
    seam: InstanceSeam,
    leases: InMemoryExecutionLeaseRepository,
  ) => OutboundCallStores["calls"] = (seam, leases) =>
    new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases),
): ContractTarget<OutboundCallStores> =>
  inMemoryTarget((seam) => {
    const leases = leasesOf(seam);
    return { calls: callsOf(seam, leases), leases };
  });

/** The broken outbound-call targets (the lease world and the call worlds run on them). */
export const BROKEN_CALL_TARGETS: Readonly<Record<string, ContractTarget<OutboundCallStores>>> = {
  "leases on the caller's clock": callsOn(
    (seam) => new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database),
  ),
  "a lease live through its expiry instant": callsOn(
    (seam) =>
      new NaiveExpiryLeaseRepository(
        seam.storeClock,
        seam.application,
        seam.database,
        throughExpiry,
      ),
  ),
  "a lease renewed whatever the time": callsOn(
    (seam) =>
      new NaiveExpiryLeaseRepository(
        seam.storeClock,
        seam.application,
        seam.database,
        holderAndEpochOnly,
      ),
  ),
  "a renewal from the lease's old end": callsOn(
    (seam) => new FromOldEndLeaseRepository(seam.storeClock, seam.application, seam.database),
  ),
  "a finish that only releases": callsOn(
    (seam) => new ReleasingFinishLeaseRepository(seam.storeClock, seam.application, seam.database),
  ),
  "a reclaim that keeps the epoch": callsOn(
    (seam) => new SameEpochReclaimLeaseRepository(seam.storeClock, seam.application, seam.database),
  ),
  "calls keyed by the step only": callsOn(onStoreTime, (seam, leases) =>
    rewritingKeys(
      new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases),
      seam.database,
      stepOnly,
    ),
  ),
  "a claim that does not compare": callsOn(
    onStoreTime,
    (seam, leases) => new UncomparedOutboundCallRepository(seam.storeClock, seam.database, leases),
  ),
};

/** The broken fenced-effect targets. */
export const BROKEN_EFFECT_TARGETS: Readonly<
  Record<string, ContractTarget<FencedEffectStores<unknown>>>
> = {
  "effects that trust the current lease's token": inMemoryTarget((seam) => {
    const stores = inMemoryFencedEffects(false)(seam);
    return {
      ...stores,
      effects: rewritingKeys(stores.effects, seam.database, currentToken),
    };
  }),
  "effects on the caller's clock": inMemoryTarget((seam) => {
    const stores = inMemoryFencedEffects(false)(seam);
    const effects = new InMemoryFencedEffectRepository(
      seam.clock,
      seam.database,
      new FencedEffectSettings(),
      stores.leases,
    );
    return { ...stores, effects };
  }),
};
