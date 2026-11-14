/**
 * #928 AC1 — the interleaving explorer bounds each action as an unleased store call: a store whose
 * `acquire` never answers fails its case within the bound (15 s; a shorter one here, the real time
 * it takes), naming the action — never a run that hangs to the suite's own timeout.
 */
import { describe, expect, it } from "vitest";
import { STORE_CALL_BOUND } from "../../../src/app/lease-fence.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { ClockSkew } from "../../../src/testing/clock-skew.js";
import { ExplorerRun } from "../../../src/testing/contracts/explorer/run.js";
import {
  ExplorerInvariant,
  ExplorerWorldKind,
  LeaseOperation,
  type ExplorerWorld,
} from "../../../src/testing/contracts/explorer/types.js";
import { worldOf } from "../../../src/testing/contracts/explorer/worlds.js";
import { waitOf } from "../../../src/infrastructure/clock.js";
import type {
  ContractTarget,
  StoreInstanceContext,
} from "../../../src/testing/contracts/instance-context.js";
import type { ExplorerStores } from "../../../src/testing/contracts/explorer/types.js";

/** A lease store whose acquire is never answered, as a call to a server that went quiet. */
class SilentLeases extends InMemoryExecutionLeaseRepository {
  override acquire(): ReturnType<InMemoryExecutionLeaseRepository["acquire"]> {
    return new Promise(() => undefined);
  }
}

const target: ContractTarget<ExplorerStores> = {
  name: "silent leases",
  instance: ({ storeClock, application }: StoreInstanceContext) => ({
    leases: new SilentLeases(storeClock, application, new InMemoryDatabase()),
  }),
};

const world = (callBound?: number): ExplorerWorld => ({
  ...worldOf(ExplorerWorldKind.Lease, 1, ClockSkew.none),
  ...(callBound === undefined ? {} : { callBound: waitOf(callBound) }),
});

describe("#928 AC1: the explorer fails a hung action fast", () => {
  it("a store whose acquire never answers fails its case within the bound, naming the action", async () => {
    const run = await ExplorerRun.open(world(150), target);

    await run.step({
      kind: "lease",
      operation: LeaseOperation.Acquire,
      instance: 1,
      tree: "tree-1",
    });

    // it returned: a hung action does not hold the run to the test's own timeout
    expect(run.observer.violations).toHaveLength(1);
    expect(run.observer.violations[0]).toMatchObject({ invariant: ExplorerInvariant.StoreError });
    expect(run.observer.violations[0]?.message).toMatch(
      /instance-1 acquire tree-1 threw StoreCallTimeoutError: .*did not answer within 150 ms/u,
    );
    await run.close();
  });

  it("the default bound is the framework's unleased bound, 15 s", () => {
    expect(STORE_CALL_BOUND).toBe(15_000);
    expect(world().callBound).toBeUndefined();
  });
});
