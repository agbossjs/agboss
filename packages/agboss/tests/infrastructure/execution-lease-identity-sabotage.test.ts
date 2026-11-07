/**
 * #591 — the identity cases of the lease contract bite: each fails on a store that keeps execution
 * ids wrongly — a check, then an insert (two instances both win the race); ids per tenant (one
 * step key space for two trees); an id forgotten when its lease is finished; ids compared without
 * case; no refusal at all — and every case passes on the real in-memory store and on a store
 * written from the public entries only.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionIdentity,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { LEASE_IDENTITY_CASES } from "../../src/testing/contracts/execution-lease-identity.cases.js";
import { LeaseTable, MapExecutionLeaseRepository } from "../fixtures/contracts/map-lease-store.js";

/** The race of before: whether the id is known, a round trip, then the insert. */
class CheckThenInsert extends MapExecutionLeaseRepository {
  override async saveExecutionIdIfAbsent({ executionId }: ExecutionIdentity): Promise<boolean> {
    const isKnown = this.executionIds.has(executionId);
    await Promise.resolve();
    if (isKnown) return false;
    this.executionIds.add(executionId);
    return true;
  }
}

/** Ids per tenant, like the leases: two tenants' trees share step keys. */
class PerTenant extends MapExecutionLeaseRepository {
  override saveExecutionIdIfAbsent({ executionId, tenantId }: ExecutionIdentity): Promise<boolean> {
    return super.saveExecutionIdIfAbsent({
      executionId: `${tenantId}\u0000${executionId}`,
      tenantId,
    });
  }
}

/** An id removed with its finished lease: a finished tree's id handed out again. */
class ForgetsOnFinish extends MapExecutionLeaseRepository {
  override async finish(executionLease: ExecutionLease): Promise<void> {
    await super.finish(executionLease);
    this.executionIds.delete(executionLease.rootExecutionId);
  }
}

/** Ids compared without case, as a case-insensitive collation would. */
class CaseInsensitive extends MapExecutionLeaseRepository {
  override saveExecutionIdIfAbsent({ executionId, tenantId }: ExecutionIdentity): Promise<boolean> {
    return super.saveExecutionIdIfAbsent({ executionId: executionId.toLowerCase(), tenantId });
  }
}

/** No identity kept: every id new. */
class KeepsNothing extends MapExecutionLeaseRepository {
  override saveExecutionIdIfAbsent(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

type MapStore = typeof MapExecutionLeaseRepository;

const applicationOf = (clock: VirtualClock, instanceId: string) =>
  applicationContextOf({
    name: "bites-application",
    version: "1.0.0",
    instanceId,
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });

/** One case's two instances of a map store on one table and clock. */
function mapInstancesOf(Store: MapStore) {
  const clock = new VirtualClock();
  const table = new LeaseTable();
  const of = (instanceId: string): ExecutionLeaseRepository =>
    new Store(table, clock, applicationOf(clock, instanceId));
  return { clock, first: of("instance-1"), second: of("instance-2") };
}

/** One case's two instances of the in-memory store on one database. */
function inMemoryInstances() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const of = (instanceId: string) =>
    new InMemoryExecutionLeaseRepository(clock, applicationOf(clock, instanceId), database);
  return { clock, first: of("instance-1"), second: of("instance-2") };
}

const caseNamed = (start: string) => {
  const found = LEASE_IDENTITY_CASES.find((each) => each.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

const RACE = "#591: 8 concurrent claims";
const ACROSS_TENANTS = "#591: an id is one across tenants";
const AFTER_FINISH = "#591: a kept id's tree takes its lease as before";
const EXACT = "#591: ids are compared exactly";
const ONCE = "#591: a new execution id is kept once";

describe("#591: the identity cases fail on a store that keeps ids wrongly", () => {
  it.each([
    [RACE, CheckThenInsert],
    [ACROSS_TENANTS, PerTenant],
    [AFTER_FINISH, ForgetsOnFinish],
    [EXACT, CaseInsensitive],
    [ONCE, KeepsNothing],
    [RACE, KeepsNothing],
    [ACROSS_TENANTS, KeepsNothing],
    [AFTER_FINISH, KeepsNothing],
  ] as const)("%s… fails on %O", async (start, Broken) => {
    await expect(caseNamed(start).run(mapInstancesOf(Broken))).rejects.toThrow();
  });

  it.each(LEASE_IDENTITY_CASES.map((each) => [each.name, each] as const))(
    "%s: passes on the in-memory store and on a store of the public entries",
    async (_name, contractCase) => {
      await expect(contractCase.run(inMemoryInstances())).resolves.toBeUndefined();
      await expect(
        contractCase.run(mapInstancesOf(MapExecutionLeaseRepository)),
      ).resolves.toBeUndefined();
    },
  );
});
