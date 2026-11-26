/**
 * #1321e (D6): a lease store on a cluster beside the database's lease row. The cluster decides who
 * holds the lease; the row is the authority for token, stop mark, pause and fence, written first —
 * on the core's in-memory database and cluster double, and on SQLite.
 */
import { describe, expect, it } from "vitest";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import {
  ClusterExecutionLeaseRepository,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
} from "../../src/infrastructure/cluster-lease.js";
import { InMemoryCluster } from "../../src/infrastructure/in-memory-cluster-lease.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { seconds } from "../../src/units/index.js";
import {
  executionLeaseClusterContract,
  type ClusterLeaseSet,
} from "../../src/testing/contracts/index.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import {
  applicationOn,
  connectionTo,
  inMemoryTarget,
  temporarySqlitePath,
} from "./contracts/store-kinds.js";

const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;
const LEASE = seconds(30);

/** One instance's pair over a shared database and cluster, each with an outage switch. */
function pairOf(database: InMemoryDatabase, cluster: InMemoryCluster, now: () => Date, id: string) {
  const application = applicationContextOf({
    name: "cluster-test",
    version: "1.0.0",
    instanceId: id,
    startedAt: new Date(0),
  });
  const store = new InMemoryExecutionLeaseRepository(
    { now: () => now() } as never,
    application,
    database,
  );
  let isDatabaseDown = false;
  const guarded = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (isDatabaseDown) return Promise.reject(new Error("the database is down"));
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  return {
    leases: new ClusterExecutionLeaseRepository(cluster.coordinatorOf(id), guarded),
    database: store,
    setDatabaseDown: (isDown: boolean) => {
      isDatabaseDown = isDown;
    },
  };
}

describe("#1321e: the cluster's lease is mirrored into the database row first", () => {
  const now = new Date("2026-01-05T09:00:00.000Z");
  const world = () => {
    const database = new InMemoryDatabase();
    const clock = { value: now };
    const cluster = new InMemoryCluster(() => clock.value);
    return {
      clock,
      cluster,
      database,
      one: pairOf(database, cluster, () => clock.value, "a"),
      two: pairOf(database, cluster, () => clock.value, "b"),
    };
  };

  it("a take is in the row (held, for good) when it is handed out", async () => {
    const { one } = world();

    const held = await one.leases.acquire("default", "root-1", LEASE);

    expect(held?.token).toBe(1);
    expect(await one.database.mirroredLeaseOf(TREE)).toEqual({
      token: 1,
      holderInstanceId: "a",
      state: MirroredLeaseState.Held,
    });
  });

  it("with the database down the take fails closed and the cluster's lease is given back", async () => {
    const { one, two } = world();
    one.setDatabaseDown(true);

    await expect(one.leases.acquire("default", "root-1", LEASE)).rejects.toThrow(
      "database is down",
    );

    expect(await two.leases.acquire("default", "root-1", LEASE)).toMatchObject({ token: 2 });
  });

  it("a cluster that forgot its counters is raised past the row, never a stale token", async () => {
    const { one, cluster } = world();
    await one.leases.acquire("default", "root-1", LEASE);
    await one.database.syncClusterLease({
      ...TREE,
      holderInstanceId: "a",
      token: 9,
      expiresAt: now,
      remaining: LEASE,
    });
    cluster.forgetCounters();

    const next = await one.leases.acquire("default", "root-1", LEASE);

    expect(next?.token).toBeGreaterThan(9);
  });

  it("sync refuses a lower token, another holder at the same token and a retired row; it keeps the marks", async () => {
    const { one } = world();
    const lease = { ...TREE, holderInstanceId: "a", token: 3, expiresAt: now, remaining: LEASE };
    await one.database.requestStop(TREE, InterruptMode.Immediate);

    expect(await one.database.syncClusterLease(lease)).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect(await one.database.syncClusterLease({ ...lease, token: 2 })).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });
    expect(await one.database.syncClusterLease({ ...lease, holderInstanceId: "b" })).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });
    expect(await one.database.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
    await one.database.endClusterLease(lease, { isRetired: true });
    expect(await one.database.syncClusterLease({ ...lease, token: 4 })).toEqual({
      outcome: ClusterLeaseSyncOutcome.Retired,
    });
  });

  it("marks are the database's; the cluster only gets a push, and a push that fails rejects after the mark is set", async () => {
    const { one, two, cluster } = world();

    await one.leases.requestStop(TREE, InterruptMode.Immediate);
    expect(cluster.pushedMarksOf(TREE)?.stop).toEqual({ mode: InterruptMode.Immediate });

    cluster.isDown = true;
    await expect(two.leases.requestCancel(TREE)).rejects.toThrow("cluster is down");
    expect(await two.database.isCancelRequested(TREE)).toBe(true);
    expect(await two.leases.isCancelRequested(TREE)).toBe(true);
    expect((await two.leases.markedOf(TREE)).stop).toEqual({ mode: InterruptMode.Immediate });
  });
});

const clusters = new WeakMap<InMemoryDatabase, InMemoryCluster>();
const switches = new WeakMap<
  object,
  { cluster: InMemoryCluster; setDown(isDown: boolean): void }
>();

describe("#1321e: the cluster lease contract on the core's in-memory pair", () => {
  const base = inMemoryTarget<ClusterLeaseSet>((seam) => {
    const cluster = clusters.get(seam.database) ?? new InMemoryCluster(() => seam.clock.now());
    clusters.set(seam.database, cluster);
    const { leases, database, setDatabaseDown } = pairOf(
      seam.database,
      cluster,
      () => seam.clock.now(),
      seam.instanceId,
    );
    const set: ClusterLeaseSet = {
      cluster: leases,
      database,
      outage: {
        // the cluster is shared by both instances: its outage is the cluster's
        cluster: (isDown) => {
          cluster.isDown = isDown;
        },
        database: setDatabaseDown,
      },
    };
    switches.set(set, { cluster, setDown: setDatabaseDown });
    return set;
  });
  executionLeaseClusterContract({ ...base, name: "in-memory cluster double" });
});

describe("#1321e: SQLite's lease row mirrors a cluster lease", () => {
  const sqlite = () => {
    const path = temporarySqlitePath();
    const make = (id: string) =>
      new SqliteExecutionLeaseRepository(
        connectionTo(path),
        { now: () => new Date("2026-01-05T09:00:00.000Z") } as never,
        applicationOn(path, id),
      );
    return { one: make("a"), two: make("b") };
  };
  const lease = (token: number, holder = "a") => ({
    ...TREE,
    holderInstanceId: holder,
    token,
    expiresAt: new Date(0),
    remaining: LEASE,
  });

  it("a mirrored lease never expires; the fence checks of a row pass until a higher token is synced", async () => {
    const { one, two } = sqlite();

    await one.syncClusterLease(lease(1));

    expect(await two.mirroredLeaseOf(TREE)).toEqual({
      token: 1,
      holderInstanceId: "a",
      state: MirroredLeaseState.Held,
    });
    // another instance's own take sees it held, however far the clock went
    expect(await two.acquire("default", "root-1", LEASE)).toBeUndefined();
  });

  it("refuses a lower token, another holder at the token, a released token and a retired row; keeps the marks", async () => {
    const { one, two } = sqlite();
    await one.requestStop(TREE, InterruptMode.Immediate);
    await one.syncClusterLease(lease(3));

    expect(await two.syncClusterLease(lease(2))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });
    expect(await two.syncClusterLease(lease(3, "b"))).toMatchObject({
      outcome: ClusterLeaseSyncOutcome.Behind,
    });
    await one.endClusterLease(lease(3), { isRetired: false });
    expect(await two.mirroredLeaseOf(TREE)).toMatchObject({ state: MirroredLeaseState.Released });
    expect(await two.syncClusterLease(lease(3))).toMatchObject({
      outcome: ClusterLeaseSyncOutcome.Behind,
    });
    expect(await two.syncClusterLease(lease(4, "b"))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    await two.endClusterLease(lease(4, "b"), { isRetired: true });
    expect(await one.syncClusterLease(lease(5))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Retired,
    });
    expect(await one.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
  });

  it("#1341c: a reclaim's mirror under an Immediate pause raises the fence to its token in the upsert; an AfterStep pause, an acquire's mirror and a reclaim after unpause leave it", async () => {
    const { one, two } = sqlite();
    await one.syncClusterLease(lease(1));
    await two.requestPause(TREE, { mode: InterruptMode.AfterStep });
    await one.syncClusterLease(lease(2), { isReclaim: true });
    expect((await two.pauseOf(TREE)).fencedThroughToken).toBeUndefined();

    await two.requestPause(TREE, { mode: InterruptMode.Immediate });
    expect(await one.syncClusterLease(lease(3), { isReclaim: true })).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect((await two.pauseOf(TREE)).fencedThroughToken).toBe(3);

    await one.endClusterLease(lease(3), { isRetired: false });
    await one.syncClusterLease(lease(4));
    expect((await two.pauseOf(TREE)).fencedThroughToken).toBe(3);
    await two.unpause(TREE);
    await one.syncClusterLease(lease(5), { isReclaim: true });
    expect((await two.pauseOf(TREE)).fencedThroughToken).toBe(3);
  });
});
