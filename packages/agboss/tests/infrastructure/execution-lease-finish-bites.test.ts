/**
 * #520 acceptance: the finished lease's edge cases bite. Each runs against a naive store — a finish
 * that matches the holder but not the epoch, one that finishes the key whoever holds it (or nobody),
 * a finish that is only a release, one that a later finish or release undoes — and fails; the real
 * store passes them all.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../src/flow/context/application-context.js";
import type { Clock } from "../../src/infrastructure/clock.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { LEASE_FINISH_EDGE_CASES } from "../../src/testing/contracts/execution-lease-finish-edges.cases.js";
import { LEASE_FINISH_CASES } from "../../src/testing/contracts/execution-lease-finish.cases.js";

type Store = new (
  clock: Clock,
  application: ApplicationContext,
  database: InMemoryDatabase,
) => ExecutionLeaseRepository;

/** A store over the database's rows, as the naive finishes below write them. */
class RowStore extends InMemoryExecutionLeaseRepository {
  constructor(
    clock: Clock,
    application: ApplicationContext,
    protected readonly rows: InMemoryDatabase,
  ) {
    super(clock, application, rows);
  }

  protected finishRow(lease: ExecutionLease): void {
    this.rows.executionLeases.set(treeKeyOf(lease.tenantId, lease.rootExecutionId), {
      lease,
      released: true,
      isFinished: true,
    });
  }
}

/** A finish that matches the holder only: an older epoch of the same instance finishes the newer. */
class HolderOnlyFinish extends RowStore {
  override finish(lease: ExecutionLease): Promise<void> {
    const stored = this.rows.executionLeases.get(treeKeyOf(lease.tenantId, lease.rootExecutionId));
    if (stored?.lease.holderInstanceId === lease.holderInstanceId) this.finishRow(stored.lease);
    return Promise.resolve();
  }
}

/** A finish of the key, whoever holds it now — or nobody. */
class KeyOnlyFinish extends RowStore {
  override finish(lease: ExecutionLease): Promise<void> {
    this.finishRow(lease);
    return Promise.resolve();
  }
}

/** The finish before #520: a release, so the key is free again. */
class FinishAsRelease extends RowStore {
  override finish(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

/** A finish that a second finish of the same lease toggles back to released. */
class TogglingFinish extends RowStore {
  override finish(lease: ExecutionLease): Promise<void> {
    const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
    if (this.rows.executionLeases.get(key)?.isFinished === true) return this.release(lease);
    return super.finish(lease);
  }

  override release(lease: ExecutionLease): Promise<void> {
    const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
    const stored = this.rows.executionLeases.get(key);
    if (stored?.lease.leaseEpoch === lease.leaseEpoch)
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
      clock,
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

const CASES = [...LEASE_FINISH_CASES, ...LEASE_FINISH_EDGE_CASES];

const caseNamed = (start: string) => {
  const found = CASES.find((each) => each.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

describe("#520 acceptance: the finished lease's cases fail on a naive store", () => {
  it.each([
    ["#520: a finish with the epoch before its holder's release", HolderOnlyFinish],
    ["#520: a finish with the epoch before a reclaim", HolderOnlyFinish],
    ["#520: released, taken by another instance, then the old holder's finish", KeyOnlyFinish],
    ["#520: a finish of a key nobody took", KeyOnlyFinish],
    ["finishing a lost lease keeps the new holder's", KeyOnlyFinish],
    ["a finished lease is never taken again", FinishAsRelease],
    ["#520: a finished key stays finished for every instance", FinishAsRelease],
    ["#520: a finished key stays finished for every instance", TogglingFinish],
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
