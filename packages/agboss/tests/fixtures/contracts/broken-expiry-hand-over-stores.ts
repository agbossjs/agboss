/**
 * #959 sabotage: a fenced-effect store and its lease store whose open write holds off a **release**
 * and the take of a released lease, but not the take of an **expired** lease — the way a lock keyed
 * on the lease's released state gets it wrong: the take by expiry goes by `expires_at` alone and
 * never reads it. The hand-over by release and take (#695) waits for the write and passes; the
 * take of a lease that ran out while the write is open is granted at once, and the stale holder's
 * write still lands. The effects are the unlocked-check ones (the lease checked once, nothing again
 * at the commit), with an "open write" mark on the lease's key while a transaction runs.
 */
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../../src/infrastructure/execution-lease.repository.js";
import type { ApplicationContext } from "../../../src/flow/context/application-context.js";
import type { StoreClock } from "../../../src/infrastructure/clock.js";
import {
  treeKeyOf,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import type {
  EffectKey,
  FencedEffectOutcome,
  FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import type { FencedEffectTarget } from "../../../src/testing/contracts/index.js";
import type { Milliseconds } from "../../../src/units/index.js";
import {
  sharedInMemory,
  type InstanceSeam,
  type StoreFactory,
} from "../../infrastructure/contracts/store-kinds.js";
import {
  UnlockedCheckEffects,
  unlockedResultsOf,
  unlockedRowsOf,
  type DeferredTransaction,
} from "./broken-hand-over-stores.js";

/** The write open on each lease key: settles when it ends. */
type OpenWrites = Map<string, Promise<void>>;

const openWritesOf = (seam: InstanceSeam): OpenWrites =>
  sharedInMemory(seam, "open-writes", (): OpenWrites => new Map());

/** Effects that mark the lease's key while their transaction is open. */
class MarkingEffects extends UnlockedCheckEffects {
  constructor(
    seam: InstanceSeam,
    results: ConstructorParameters<typeof UnlockedCheckEffects>[1],
    private readonly open: OpenWrites,
  ) {
    super(seam, results);
  }

  protected override async runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<DeferredTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const mark = treeKeyOf(key.tenantId, key.leaseExecutionId);
    const call = super.runInTransaction(key, work);
    this.open.set(
      mark,
      call.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await call;
    } finally {
      this.open.delete(mark);
    }
  }
}

/** Leases whose release, and take of a released lease, wait for the open write; a take by expiry does not. */
class ReleaseLockedLeases extends InMemoryExecutionLeaseRepository {
  constructor(
    clock: Pick<StoreClock, "now">,
    application: ApplicationContext,
    private readonly rows: InMemoryDatabase,
    private readonly open: OpenWrites,
  ) {
    super(clock, application, rows);
  }

  override async release(lease: ExecutionLease): Promise<void> {
    await this.open.get(treeKeyOf(lease.tenantId, lease.rootExecutionId));
    return super.release(lease);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = treeKeyOf(tenantId, rootExecutionId);
    if (this.rows.executionLeases.get(key)?.released === true) await this.open.get(key);
    return super.acquire(tenantId, rootExecutionId, duration);
  }
}

/** The lease store of one instance. */
export const releaseLockedLeases: StoreFactory<ReleaseLockedLeases> = (seam) =>
  new ReleaseLockedLeases(seam.storeClock, seam.application, seam.database, openWritesOf(seam));

/** The fenced-effect target of one instance on those stores. */
export const releaseLockedEffects: StoreFactory<FencedEffectTarget<DeferredTransaction>> = (
  seam,
) => ({
  effects: new MarkingEffects(seam, unlockedResultsOf(seam), openWritesOf(seam)),
  leases: releaseLockedLeases(seam),
  rows: unlockedRowsOf(seam),
});
