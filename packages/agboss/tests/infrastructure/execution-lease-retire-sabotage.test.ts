/**
 * #520 acceptance: the retired lease's edge cases bite. Each runs against a naive store — a retire
 * that matches the holder but not the epoch, one that retires the key whoever holds it (or nobody),
 * a retire that is only a release, one that a later retire or release undoes — and fails; the real
 * store passes them all.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../src/flow/context/application-context.js";
import type { StoreClock } from "../../src/infrastructure/clock.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { LEASE_RETIRE_EDGE_CASES } from "../../src/testing/contracts/execution-lease-retire-edges.cases.js";
import { LEASE_RETIRE_CASES } from "../../src/testing/contracts/execution-lease-retire.cases.js";
import { storeClockOf } from "../helpers/store-clock.js";

type Store = new (
  clock: StoreClock,
  application: ApplicationContext,
  database: InMemoryDatabase,
) => ExecutionLeaseRepository;

/** A store over the database's rows, as the naive retires below write them. */
class RowStore extends InMemoryExecutionLeaseRepository {
  constructor(
    clock: StoreClock,
    application: ApplicationContext,
    protected readonly rows: InMemoryDatabase,
  ) {
    super(clock, application, rows);
  }

  protected retireRow(lease: ExecutionLease): void {
    this.rows.executionLeases.set(treeKeyOf(lease.tenantId, lease.rootExecutionId), {
      lease,
      released: true,
      isRetired: true,
    });
  }
}

/** A retire that matches the holder only: an older epoch of the same instance retires the newer. */
class HolderOnlyFinish extends RowStore {
  override retire(lease: ExecutionLease): Promise<void> {
    const stored = this.rows.executionLeases.get(treeKeyOf(lease.tenantId, lease.rootExecutionId));
    if (stored?.lease.holderInstanceId === lease.holderInstanceId) this.retireRow(stored.lease);
    return Promise.resolve();
  }
}

/** A retire of the key, whoever holds it now — or nobody. */
class KeyOnlyFinish extends RowStore {
  override retire(lease: ExecutionLease): Promise<void> {
    this.retireRow(lease);
    return Promise.resolve();
  }
}

/** The retire before #520: a release, so the key is free again. */
class RetireAsRelease extends RowStore {
  override retire(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

/** A retire that a second retire of the same lease toggles back to released. */
class TogglingRetire extends RowStore {
  override retire(lease: ExecutionLease): Promise<void> {
    const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
    if (this.rows.executionLeases.get(key)?.isRetired === true) return this.release(lease);
    return super.retire(lease);
  }

  override release(lease: ExecutionLease): Promise<void> {
    const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
    const stored = this.rows.executionLeases.get(key);
    if (stored?.lease.token === lease.token)
      this.rows.executionLeases.set(key, { lease: stored.lease, released: true });
    return Promise.resolve();
  }
}

/** One case's two instances of `Store` on one database and clock. */
function instancesOf(Store: Store) {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const of = (instanceId: string) =>
    new Store(
      storeClockOf(clock),
      applicationContextOf({
        name: "bites-application",
        version: "1.0.0",
        instanceId,
        startedAt: clock.now(),
        environmentName: "test",
        environment: NO_ENVIRONMENT_VALUES,
      }),
      database,
    );
  return { clock, first: of("instance-1"), second: of("instance-2") };
}

const CASES = [...LEASE_RETIRE_CASES, ...LEASE_RETIRE_EDGE_CASES];

const caseNamed = (start: string) => {
  const found = CASES.find((each) => each.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

describe("#520 acceptance: the retired lease's cases fail on a naive store", () => {
  it.each([
    ["#520: a retire with the epoch before its holder's release", HolderOnlyFinish],
    ["#520: a retire with the epoch before a reclaim", HolderOnlyFinish],
    ["#520: released, taken by another instance, then the old holder's retire", KeyOnlyFinish],
    ["#520: a retire of a key nobody took", KeyOnlyFinish],
    ["retiring a lost lease keeps the new holder's", KeyOnlyFinish],
    ["a retired lease is never taken again", RetireAsRelease],
    ["#520: a retired key stays retired for every instance", RetireAsRelease],
    ["#520: a retired key stays retired for every instance", TogglingRetire],
  ] as const)("%s… fails on %O", async (start, Naive) => {
    await expect(caseNamed(start).run(instancesOf(Naive))).rejects.toThrow();
  });

  it.each(CASES.map((each) => [each.name, each] as const))(
    "%s: passes on the real in-memory store",
    async (_name, contractCase) => {
      await expect(
        contractCase.run(instancesOf(InMemoryExecutionLeaseRepository)),
      ).resolves.toBeUndefined();
    },
  );
});
