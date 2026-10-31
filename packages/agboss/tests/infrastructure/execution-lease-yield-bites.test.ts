/**
 * #516 acceptance: the yielded lease's edge cases bite. Each runs against a naive store — the yield
 * as the release it was before #516, a reclaim that never asks whether the lease was taken, a yield
 * that answers once, a reclaim that keeps the old epoch — and fails; the real store passes them all.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { LEASE_YIELD_EDGE_CASES } from "../../src/testing/contracts/execution-lease-yield-edges.cases.js";
import type { Milliseconds } from "../../src/units/index.js";

type Store = new (
  ...args: ConstructorParameters<typeof InMemoryExecutionLeaseRepository>
) => ExecutionLeaseRepository;

/** The yield before #516: a release — the tree is free while its holder waits. */
class YieldAsRelease extends InMemoryExecutionLeaseRepository {
  override async yield(lease: ExecutionLease): Promise<boolean> {
    await this.release(lease);
    return true;
  }
}

/** A reclaim that never asks whether another instance took the lease meanwhile. */
class BlindReclaim extends InMemoryExecutionLeaseRepository {
  override async reclaim(lease: ExecutionLease, duration: Milliseconds) {
    const reclaimed = await super.reclaim(lease, duration);
    return reclaimed ?? { ...lease, leaseEpoch: lease.leaseEpoch + 1 };
  }
}

/** A yield that answers true only the first time. */
class YieldOnce extends InMemoryExecutionLeaseRepository {
  readonly #yielded = new Set<number>();

  override async yield(lease: ExecutionLease): Promise<boolean> {
    if (this.#yielded.has(lease.leaseEpoch)) return false;
    this.#yielded.add(lease.leaseEpoch);
    return super.yield(lease);
  }
}

/** A reclaim that renews the old epoch instead of moving to the next one. */
class SameEpochReclaim extends InMemoryExecutionLeaseRepository {
  override async reclaim(lease: ExecutionLease, duration: Milliseconds) {
    return (await this.renew(lease, duration)) ? lease : undefined;
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

const caseNamed = (start: string) => {
  const found = LEASE_YIELD_EDGE_CASES.find((each) => each.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

describe("#516 acceptance: the yield edge cases fail on a naive store", () => {
  it.each([
    ["a yielded lease 1 ms before", YieldAsRelease],
    ["an expired yielded lease, reclaimed and taken at once", BlindReclaim],
    ["a lease yielded twice", YieldOnce],
    ["after a reclaim the old epoch is stale", SameEpochReclaim],
  ] as const)("%s… fails on %O", async (start, Naive) => {
    await expect(caseNamed(start).run(instancesOf(Naive))).rejects.toThrow();
  });

  it.each(LEASE_YIELD_EDGE_CASES.map((each) => [each.name, each] as const))(
    "%s: passes on the real in-memory store",
    async (_name, contractCase) => {
      await expect(
        contractCase.run(instancesOf(InMemoryExecutionLeaseRepository)),
      ).resolves.toBeUndefined();
    },
  );
});
