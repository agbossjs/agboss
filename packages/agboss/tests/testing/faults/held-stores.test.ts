import { afterEach, describe, expect, it, vi } from "vitest";
import { depsOf } from "../../../src/components/container/container.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import { InMemoryFencedEffectRepository } from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import {
  heldMethodsOf,
  heldStoreSeam,
  withHoldPoints,
} from "../../../src/testing/faults/held-stores.js";
import { HoldPhase, HoldPoints } from "../../../src/testing/faults/hold-points.js";
import { OperationHistory, OperationPhase } from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";
import { StoreOutageError, StoreOutageMode } from "../../../src/testing/faults/store-outage.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

/** An in-memory lease store with hold points, of instance `instanceId`, on `database`. */
function heldLeases(database: InMemoryDatabase, instanceId: string): ExecutionLeaseRepository {
  const Held = withHoldPoints(InMemoryExecutionLeaseRepository);
  const clock = new VirtualClock();
  const application = applicationContextOf({
    name: "held-test",
    version: "1.0.0",
    instanceId,
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  const Concrete: unknown = Held;
  return new (Concrete as new (...args: unknown[]) => ExecutionLeaseRepository)(
    clock,
    application,
    database,
  );
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

const history = new OperationHistory();
const points = new HoldPoints();

afterEach(() => {
  points.releaseAll();
  heldStoreSeam.outage.end();
});
heldStoreSeam.points = points;
heldStoreSeam.recorder = history;
heldStoreSeam.process = "test";
heldStoreSeam.instanceId = "instance-1";

describe("#484 AC5: withHoldPoints — any store of a held contract, its operations held and recorded", () => {
  it("is a subclass of the store, of its deps, its backend and its name", () => {
    const Held = withHoldPoints(SqliteExecutionLeaseRepository);
    expect(
      Object.prototype.isPrototypeOf.call(SqliteExecutionLeaseRepository.prototype, Held.prototype),
    ).toBe(true);
    expect(depsOf(Held)).toEqual(depsOf(SqliteExecutionLeaseRepository));
    expect(Held.backend).toBe("sqlite");
    expect(Held.name).toBe("HeldSqliteExecutionLeaseRepository");
  });

  it("covers the lease, fenced-effect, outbound-call and child-queue contracts, and refuses another class", () => {
    for (const store of [
      InMemoryExecutionLeaseRepository,
      InMemoryFencedEffectRepository,
      InMemoryOutboundCallRepository,
      InMemoryChildExecutionQueueRepository,
    ])
      expect(heldMethodsOf(store)).toBeDefined();
    expect(heldMethodsOf(InMemoryDatabase)).toBeUndefined();
    expect(() => withHoldPoints(InMemoryDatabase)).toThrow(TypeError);
  });

  it("holds an acquire before the store is asked: another instance's acquire wins meanwhile", async () => {
    const database = new InMemoryDatabase();
    const first = heldLeases(database, "instance-1");
    const second = heldLeases(database, "instance-2");
    points.arm({ point: StoreHoldPoint.LeaseAcquire, key: "root-1" });
    const held = first.acquire("default", "root-1", seconds(30));
    expect(await settled(held)).toBe(false);
    expect(await second.acquire("default", "root-1", seconds(30))).toMatchObject({
      leaseEpoch: 1,
      holderInstanceId: "instance-2",
    });
    points.releaseAll();
    expect(await held).toBeUndefined();
  });

  it("holds after the store answered, and records every operation's invoke and complete with what it said", async () => {
    const database = new InMemoryDatabase();
    const leases = heldLeases(database, "instance-1");
    points.arm({ point: StoreHoldPoint.LeaseAcquire, phase: HoldPhase.After });
    const taking = leases.acquire("default", "root-2", seconds(30));
    expect(await settled(taking)).toBe(false);
    const operation = history.operations.at(-1);
    expect(operation?.invoke).toMatchObject({
      phase: OperationPhase.Invoke,
      process: "test",
      instanceId: "instance-1",
      operation: "lease.acquire",
      key: "root-2",
      input: { tenantId: "default", rootExecutionId: "root-2" },
    });
    expect(operation?.complete).toMatchObject({
      phase: OperationPhase.Complete,
      output: { leaseEpoch: 1, holderInstanceId: "instance-1", rootExecutionId: "root-2" },
    });
    points.releaseAll();
    const lease = await taking;
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    expect(await leases.renew(lease, seconds(30))).toBe(seconds(30));
    await leases.finish(lease);
    expect(
      history.operations
        .slice(-2)
        .map(({ invoke, complete }) => [invoke.operation, complete?.output]),
    ).toEqual([
      ["lease.renew", seconds(30)],
      ["lease.finish", null],
    ]);
  });

  it("refuses during an outage before the store is asked; records a store's error and rethrows it", async () => {
    const database = new InMemoryDatabase();
    const leases = heldLeases(database, "instance-1");
    const before = history.operations.length;
    heldStoreSeam.outage.begin(StoreOutageMode.Refuse);
    await expect(leases.acquire("default", "root-3", seconds(30))).rejects.toThrow(
      StoreOutageError,
    );
    heldStoreSeam.outage.end();
    expect(history.operations.length).toBe(before);
    const lease = {
      tenantId: "default",
      rootExecutionId: "root-x",
      holderInstanceId: "instance-1",
      leaseEpoch: 1,
      expiresAt: new Date(0),
      remaining: seconds(30),
    };
    vi.spyOn(InMemoryExecutionLeaseRepository.prototype, "release").mockRejectedValueOnce(
      new RangeError("the disk is full"),
    );
    const failing = heldLeases(database, "instance-1");
    await expect(failing.release(lease)).rejects.toThrow("the disk is full");
    expect(history.operations.at(-1)?.complete?.error).toEqual({
      name: "RangeError",
      message: "the disk is full",
    });
  });
});
