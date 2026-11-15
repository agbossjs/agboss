/**
 * #909, #1117: fencing stores whose cancel mark is lifted, the ways a port gets the permanent mark
 * wrong — and a lease store that loses it:
 *
 * - `prunedOnceRootRetired`: the retention lifts a mark older than its cutoff once the root's lease
 *   is retired (#1056's rule): a child lease of the tree still live writes after the cancel;
 * - `prunedByAge`: the retention lifts every mark older than its cutoff (#909's first port): a tree
 *   not over, or cancelled before its first acquire, writes after the cancel;
 * - `markDroppedByAcquire`: the lease store's `acquire` writes the row anew without its mark (an
 *   `INSERT OR REPLACE` of the lease columns only): the next holder writes after the cancel.
 */
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import type { ExecutionLease } from "../../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  InMemoryFencedEffectRepository,
  type InMemoryFencedEffectTransaction,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import {
  treeKeyOf,
  type ExecutionLeaseRow,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import type { Milliseconds } from "../../../src/units/index.js";
import type {
  FencedEffectTarget,
  OutboundCallTarget,
} from "../../../src/testing/contracts/index.js";
import type { InstanceSeam, StoreFactory } from "../../infrastructure/contracts/store-kinds.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";

/** Which marks a broken retention lifts: of a row, before the cutoff (ms). */
type Lifted = (row: ExecutionLeaseRow, before: number) => boolean;

/** The rows' marks `isLifted` says, removed — what the broken sweep does after its own rows. */
function liftedMarks(database: InMemoryDatabase, before: number, isLifted: Lifted): void {
  for (const [key, row] of database.executionLeases) {
    if (row.cancelRequestedAt === undefined || !isLifted(row, before)) continue;
    const { cancelRequestedAt: _lifted, ...kept } = row;
    database.executionLeases.set(key, kept);
  }
}

const leasesOf = (seam: InstanceSeam) =>
  new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database);

/** The core's in-memory fencing stores whose sweeps also lift the marks `isLifted` says. */
const liftingStores = (isLifted: Lifted) => ({
  effects: ((seam: InstanceSeam) => {
    const built = inMemoryFencedEffects(false)(seam);
    const leases = leasesOf(seam);
    const effects = new InMemoryFencedEffectRepository(
      seam.storeClock,
      seam.database,
      new FencedEffectSettings(),
      leases,
    );
    const swept = effects.deleteByStoredAtBefore.bind(effects);
    effects.deleteByStoredAtBefore = async (cutoff) => {
      await swept(cutoff);
      liftedMarks(seam.database, cutoff.getTime(), isLifted);
    };
    return { ...built, effects, leases };
  }) satisfies StoreFactory<FencedEffectTarget<InMemoryFencedEffectTransaction>>,
  calls: ((seam: InstanceSeam) => {
    const built = inMemoryOutboundCalls(seam);
    const leases = leasesOf(seam);
    const calls = new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases);
    const swept = calls.deleteByEndedAtBefore.bind(calls);
    calls.deleteByEndedAtBefore = async (cutoff) => {
      await swept(cutoff);
      liftedMarks(seam.database, cutoff.getTime(), isLifted);
    };
    return { ...built, calls, leases };
  }) satisfies StoreFactory<OutboundCallTarget>,
});

/** #1056's rule: a mark older than the cutoff, lifted once the root's own lease is retired. */
export const prunedOnceRootRetired = liftingStores(
  (row, before) => row.isRetired === true && (row.cancelRequestedAt ?? before) < before,
);

/** #909's first port: a mark older than the cutoff, lifted by age alone. */
export const prunedByAge = liftingStores(
  (row, before) => (row.cancelRequestedAt ?? before) < before,
);

/** A lease store whose `acquire` writes the lease columns anew: the row's mark is gone. */
export class MarkDroppingLeases extends InMemoryExecutionLeaseRepository {
  readonly #rows: InMemoryDatabase;

  constructor(seam: InstanceSeam) {
    super(seam.storeClock, seam.application, seam.database);
    this.#rows = seam.database;
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.acquire(tenantId, rootExecutionId, duration);
    if (taken !== undefined)
      this.#rows.executionLeases.set(treeKeyOf(tenantId, rootExecutionId), {
        lease: taken,
        released: false,
      });
    return taken;
  }
}

/** The core's in-memory fencing stores over `MarkDroppingLeases`. */
export const markDroppedByAcquire = {
  leases: (seam: InstanceSeam) => new MarkDroppingLeases(seam),
  effects: ((seam: InstanceSeam) => {
    const built = inMemoryFencedEffects(false)(seam);
    const leases = new MarkDroppingLeases(seam);
    const effects = new InMemoryFencedEffectRepository(
      seam.storeClock,
      seam.database,
      new FencedEffectSettings(),
      leases,
    );
    return { ...built, effects, leases };
  }) satisfies StoreFactory<FencedEffectTarget<InMemoryFencedEffectTransaction>>,
  calls: ((seam: InstanceSeam) => {
    const built = inMemoryOutboundCalls(seam);
    const leases = new MarkDroppingLeases(seam);
    const calls = new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases);
    return { ...built, calls, leases };
  }) satisfies StoreFactory<OutboundCallTarget>,
};
