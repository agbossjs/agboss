import { expect } from "vitest";
import type { ExecutionIdStore } from "../../infrastructure/execution-id-store.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { MirroredLeaseState } from "../../infrastructure/cluster-lease-types.js";
import { InterruptMode } from "../../app/interrupt-types.js";
import { seconds } from "../../units/index.js";
import { registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

/**
 * The cluster lease contract (#1321e, D6): what a lease store on a cluster (Redis) must do beside the
 * database's lease store, one instance's pair of them. The cluster decides who holds a tree's lease;
 * the **database's row** is the authority for the token, the stop mark, the external pause and its
 * fence, written before the cluster acknowledges. A Redis failure must never let a stale token or a
 * missing mark through: every case that breaks one side checks the other stays closed.
 */

/** One instance's pair: the cluster's lease store, the database store it mirrors into, and the outage switches. */
export interface ClusterLeaseSet {
  /** The lease store under test: its liveness is the cluster's, its marks and tokens the database's. */
  readonly cluster: ExecutionLeaseRepository;
  /** The application's `ExecutionIdStore` — the database lease store of the same backing database. */
  readonly database: ExecutionIdStore;
  /** Makes every call of the cluster (or of the database) of this instance's pair reject, or answer again. */
  readonly outage: {
    cluster(isDown: boolean): void;
    database(isDown: boolean): void;
  };
}

const LEASE = seconds(30);
const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;

const CLUSTER_CASES: readonly ContractCase<ClusterLeaseSet>[] = [
  {
    name: "a take is in the database's row before it is handed out: token, holder, held",
    run: async ({ first }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);

      expect(held).toMatchObject({ token: 1, holderInstanceId: "instance-1" });
      expect(await first.database.mirroredLeaseOf(TREE)).toEqual({
        token: 1,
        holderInstanceId: "instance-1",
        state: MirroredLeaseState.Held,
      });
    },
  },
  {
    name: "a takeover past the lease is in the row at token + 1; the old holder's renew is refused",
    run: async ({ clock, first, second }) => {
      const old = await first.cluster.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const taken = await second.cluster.acquire("default", "root-1", LEASE);

      expect(taken).toMatchObject({ token: 2, holderInstanceId: "instance-2" });
      expect(await second.database.mirroredLeaseOf(TREE)).toMatchObject({
        token: 2,
        state: MirroredLeaseState.Held,
      });
      expect(old && (await first.cluster.renew(old, LEASE))).toBeUndefined();
    },
  },
  {
    name: "a database that cannot be written fails the take closed and gives the cluster's lease back",
    run: async ({ first, second }) => {
      first.outage.database(true);
      await expect(first.cluster.acquire("default", "root-1", LEASE)).rejects.toThrow();
      first.outage.database(false);

      const next = await second.cluster.acquire("default", "root-1", LEASE);

      expect(next).toBeDefined();
      expect(await second.database.mirroredLeaseOf(TREE)).toMatchObject({ state: "held" });
    },
  },
  {
    name: "a cluster whose counters fell behind the row never hands out a stale token",
    run: async ({ first, second }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);
      if (held === undefined) throw new Error("no lease");
      await first.cluster.release(held);
      // the row is at token 7, ahead of the cluster's counter
      const ahead = { ...held, holderInstanceId: "instance-2", token: 7 };
      await second.database.syncClusterLease(ahead);
      await second.database.endClusterLease(ahead, { isRetired: false });

      const next = await first.cluster.acquire("default", "root-1", LEASE);

      expect(next === undefined || next.token > 7).toBe(true);
      expect((await first.database.mirroredLeaseOf(TREE))?.token).toBeGreaterThanOrEqual(7);
    },
  },
  {
    name: "a release is in the row before the cluster's key changes; with the database down it fails and keeps the lease",
    run: async ({ first, second }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);
      if (held === undefined) throw new Error("no lease");

      first.outage.database(true);
      await expect(first.cluster.release(held)).rejects.toThrow();
      first.outage.database(false);
      expect(await second.cluster.acquire("default", "root-1", LEASE)).toBeUndefined();

      await first.cluster.release(held);

      expect(await first.database.mirroredLeaseOf(TREE)).toMatchObject({
        state: MirroredLeaseState.Released,
      });
      expect(await second.cluster.acquire("default", "root-1", LEASE)).toMatchObject({ token: 2 });
    },
  },
  {
    name: "a retire is in the row for good: no later take of the tree gets a lease",
    run: async ({ first, second }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);
      if (held === undefined) throw new Error("no lease");

      await first.cluster.retire(held);

      expect(await first.database.mirroredLeaseOf(TREE)).toMatchObject({
        state: MirroredLeaseState.Retired,
      });
      expect(await second.cluster.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "a stop is durable in the database before the cluster is told; a cluster that is down rejects the call after the mark is set, and a repeat completes",
    run: async ({ first, second }) => {
      first.outage.cluster(true);
      await expect(first.cluster.requestStop(TREE, InterruptMode.Immediate)).rejects.toThrow();
      expect(await second.database.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
      expect(await first.cluster.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
      first.outage.cluster(false);

      await first.cluster.requestStop(TREE, InterruptMode.Immediate);

      expect(await second.cluster.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
    },
  },
  {
    name: "a cancel mark is read from the database, never from the cluster: it holds with the cluster down",
    run: async ({ first, second }) => {
      await first.cluster.requestCancel(TREE);
      second.outage.cluster(true);

      expect(await second.cluster.isCancelRequested(TREE)).toBe(true);
      expect((await second.cluster.markedOf(TREE)).isCancelRequested).toBe(true);
    },
  },
  {
    name: "an Immediate pause raises the fence in the database; the marks and the fence are read with the cluster down, and unpause keeps the fence",
    run: async ({ first, second }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);
      await first.cluster.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "ops" });
      second.outage.cluster(true);

      expect(await second.cluster.pauseOf(TREE)).toMatchObject({
        pause: { mode: InterruptMode.Immediate },
        fencedThroughToken: held?.token,
      });
      second.outage.cluster(false);
      await second.cluster.unpause(TREE);
      expect((await second.cluster.pauseOf(TREE)).pause).toBeUndefined();
      expect((await second.cluster.pauseOf(TREE)).fencedThroughToken).toBe(held?.token);
    },
  },
  {
    name: "#1341c: a reclaim under an Immediate pause is mirrored with the fence raised to its token, in the row's own step; an acquire under the pause is not fenced",
    run: async ({ first, second }) => {
      const held = await first.cluster.acquire("default", "root-1", LEASE);
      if (held === undefined) throw new Error("the first take of a free tree must take its lease");
      await first.cluster.yield(held);
      await second.cluster.requestPause(TREE, { mode: InterruptMode.Immediate });

      const reclaimed = await first.cluster.reclaim(held, LEASE);

      expect(reclaimed).toMatchObject({ token: held.token + 1 });
      expect(await second.database.mirroredLeaseOf(TREE)).toMatchObject({
        token: held.token + 1,
        state: MirroredLeaseState.Held,
      });
      expect((await second.cluster.pauseOf(TREE)).fencedThroughToken).toBe(reclaimed?.token);
      if (reclaimed === undefined) throw new Error("a yielded lease must be reclaimed");
      await first.cluster.release(reclaimed);
      const taken = await second.cluster.acquire("default", "root-1", LEASE);
      expect(taken).toMatchObject({ token: reclaimed.token + 1 });
      expect((await second.cluster.pauseOf(TREE)).fencedThroughToken).toBe(reclaimed.token);
    },
  },
  {
    name: "the execution id is kept by the database, once, whichever instance asks",
    run: async ({ first, second }) => {
      const identity = { executionId: "exec-1", tenantId: "default" };

      expect(await first.cluster.claimExecutionId(identity)).toBe(true);
      expect(await second.cluster.claimExecutionId(identity)).toBe(false);
    },
  },
];

/**
 * A cluster lease store with the database store it mirrors into (#1321e): the order of the two
 * writes, the fail-closed paths, and the database as the only authority for marks and fences.
 */
export function executionLeaseClusterContract(target: ContractTarget<ClusterLeaseSet>): void {
  registerContract("cluster lease contract", target, [{ cases: CLUSTER_CASES }], (set) =>
    set.cluster.ping(),
  );
}
