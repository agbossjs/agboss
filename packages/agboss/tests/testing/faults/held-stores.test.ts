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
  heldStoreState,
  reportHeldOperations,
  withHoldPoints,
  type HeldOperationsReport,
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

/** A report a JavaScript caller could pass, typed as one. */
const untypedReport = (value: unknown): HeldOperationsReport => value as HeldOperationsReport;
const points = new HoldPoints();

afterEach(() => {
  points.releaseAll();
  heldStoreState.outage.end();
});
heldStoreState.points = points;
heldStoreState.recorders.add(history);
heldStoreState.process = "test";
heldStoreState.instanceId = "instance-1";

describe("#484 AC5: withHoldPoints — any store of a held contract, its operations held and recorded", () => {
  it("is a subclass of the store, of its deps, its backend and its name", () => {
    const Held = withHoldPoints(SqliteExecutionLeaseRepository);
    expect(
      Object.prototype.isPrototypeOf.call(SqliteExecutionLeaseRepository.prototype, Held.prototype),
    ).toBe(true);
    expect(depsOf(Held)).toEqual(depsOf(SqliteExecutionLeaseRepository));
    expect(Held.store.backend).toBe("sqlite");
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
      token: 1,
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
      output: { token: 1, holderInstanceId: "instance-1", rootExecutionId: "root-2" },
    });
    points.releaseAll();
    const lease = await taking;
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    expect(await leases.renew(lease, seconds(30))).toBe(seconds(30));
    await leases.retire(lease);
    expect(
      history.operations
        .slice(-2)
        .map(({ invoke, complete }) => [invoke.operation, complete?.output]),
    ).toEqual([
      ["lease.renew", seconds(30)],
      ["lease.retire", null],
    ]);
  });

  it("refuses during an outage before the store is asked; records a store's error and rethrows it", async () => {
    const database = new InMemoryDatabase();
    const leases = heldLeases(database, "instance-1");
    const before = history.operations.length;
    heldStoreState.outage.begin(StoreOutageMode.Refuse);
    await expect(leases.acquire("default", "root-3", seconds(30))).rejects.toThrow(
      StoreOutageError,
    );
    heldStoreState.outage.end();
    expect(history.operations.length).toBe(before);
    const lease = {
      tenantId: "default",
      rootExecutionId: "root-x",
      holderInstanceId: "instance-1",
      token: 1,
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

describe("#831: reportHeldOperations — a store's own process test hears its held stores, and undoes it", () => {
  it("names the instance, hears every operation and every hold; its undo stops both and gives the instance back", async () => {
    const database = new InMemoryDatabase();
    const leases = heldLeases(database, "instance-1");
    const operations: string[] = [];
    const holds: string[] = [];
    const undo = reportHeldOperations({
      instanceId: "pg-instance",
      onOperation: (event) =>
        operations.push(`${event.phase}:${event.operation}:${event.instanceId}`),
      onHeld: (held) => holds.push(`${held.point}:${String(held.key)}`),
    });

    points.arm({ point: StoreHoldPoint.LeaseAcquire, key: "root-r" });
    const taking = leases.acquire("default", "root-r", seconds(30));
    expect(await settled(taking)).toBe(false);
    points.releaseAll();
    await taking;

    expect(holds).toEqual(["lease.acquire:root-r"]);
    expect(operations).toEqual([
      "invoke:lease.acquire:pg-instance",
      "complete:lease.acquire:pg-instance",
    ]);
    // the history the suite keeps hears them too: a reporter is one more recorder, not the only one
    expect(history.operations.at(-1)?.invoke.instanceId).toBe("pg-instance");

    undo();
    undo();
    expect(heldStoreState.instanceId).toBe("instance-1");
    points.arm({ point: StoreHoldPoint.LeaseAcquire, key: "root-s" });
    const again = leases.acquire("default", "root-s", seconds(30));
    await settled(again);
    points.releaseAll();
    await again;
    expect(holds).toHaveLength(1);
    expect(operations).toHaveLength(2);
  });

  it("a listener that throws never changes the store's answer: its error is thrown apart", async () => {
    const thrown: unknown[] = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        thrown.push(error);
      }
    });
    const leases = heldLeases(new InMemoryDatabase(), "instance-1");
    const undo = reportHeldOperations({
      onOperation: () => {
        throw new Error("a failed expect");
      },
    });
    try {
      expect(await leases.acquire("default", "root-t", seconds(30))).toMatchObject({
        holderInstanceId: "instance-1",
      });
      expect(thrown.map((error) => (error as Error).message)).toEqual([
        "a failed expect",
        "a failed expect",
      ]);
    } finally {
      undo();
      spy.mockRestore();
    }
  });

  it("refuses a report that would hear nothing, an unknown key, and a second instance id while one names the history", () => {
    expect(() => reportHeldOperations({})).toThrow(/would hear nothing/u);
    expect(() => reportHeldOperations(untypedReport({ onOperations: () => undefined }))).toThrow(
      /onOperations — it takes instanceId, onOperation and onHeld/u,
    );
    const undo = reportHeldOperations({ instanceId: "a", onHeld: () => undefined });
    try {
      expect(() => reportHeldOperations({ instanceId: "b", onHeld: () => undefined })).toThrow(
        /named by instance a already/u,
      );
      reportHeldOperations({ onHeld: () => undefined })();
    } finally {
      undo();
    }
    expect(heldStoreState.instanceId).toBe("instance-1");
    reportHeldOperations({ instanceId: "b", onHeld: () => undefined })();
  });

  it("without an instance id, the history's instance is left as it is", () => {
    const undo = reportHeldOperations({ onHeld: () => undefined });
    expect(heldStoreState.instanceId).toBe("instance-1");
    undo();
    expect(heldStoreState.instanceId).toBe("instance-1");
  });
});
