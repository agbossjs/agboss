import { expect } from "vitest";
import {
  executionLeasesOf,
  type LeaseEventLog,
  type LeaseTake,
} from "../../app/execution-leases.js";
import { ExecutionObserverManager } from "../../core/observer-manager.js";
import {
  InMemoryExecutionLeaseEventRepository,
  LeaseTakeoverReason,
  type ExecutionLeaseEventRecord,
} from "../../infrastructure/execution-lease-event.repository.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { ExecutionTree } from "../../infrastructure/execution-tree.repository.js";
import { InMemoryDatabase } from "../../infrastructure/in-memory-database.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import { seconds } from "../../units/index.js";
import type { VirtualClock } from "../clock.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** The child whose lease the cases below take: its own key, in the tree `root-1`. */
const CHILD: ExecutionTree = { tenantId: "default", rootExecutionId: "child-1" };

/** A remote child's reclaim: a takeover of a child a worker was running. */
const RECLAIM: LeaseTake = {
  reason: LeaseTakeoverReason.RemoteChild,
  isTakeover: true,
  rootExecutionId: "root-1",
};

const SILENT: FrameworkLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A lease log in memory (the store under test is the lease store): its rows as written. */
function leaseLogOn(clock: VirtualClock): {
  readonly events: LeaseEventLog;
  readonly rows: () => Promise<readonly ExecutionLeaseEventRecord[]>;
} {
  const repository = new InMemoryExecutionLeaseEventRepository(new InMemoryDatabase());
  const events: LeaseEventLog = {
    repository,
    observer: new ExecutionObserverManager([]),
    mask: (event) => Promise.resolve(event),
    log: SILENT,
    clock,
    recording: lazyLoad(import("../../app/lease-events.js")),
  };
  const rows = () =>
    repository.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1");
  return { events, rows };
}

/**
 * The framework's take of finished work (#520) over the store: a lease its holder finished is not
 * taken over — no lease, no `Takeover` row in the lease log —, and a take whose work ended while
 * the store was asked gives the lease back at once, recording nothing.
 */
export const LEASE_FINISH_HOLDER_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a stale instance's reclaim of a finished child's lease takes nothing and writes no takeover, also past the lease",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const { events, rows } = leaseLogOn(clock);
      const holder = await executionLeasesOf(first, clock).hold(CHILD);
      await holder.release({ isFinished: true });
      const stale = executionLeasesOf(second, clock, { events });

      const atOnce = await stale.tryHold(CHILD, RECLAIM);
      await clock.advance(seconds(31));
      const later = await stale.tryHold(CHILD, RECLAIM);

      expect(atOnce).toBeUndefined();
      expect(later).toBeUndefined();
      expect(await rows()).toEqual([]);
    },
  },
  {
    name: "a take whose work ended while the store was asked gives the lease back at once and writes no takeover",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const { events, rows } = leaseLogOn(clock);
      let looks = 0;
      // over at its second look: once the store gave the lease
      const isOver = (): Promise<boolean> => Promise.resolve((looks += 1) > 1);

      const taken = await executionLeasesOf(second, clock, { events }).tryHold(CHILD, {
        ...RECLAIM,
        isOver,
      });
      const next = await first.acquire(CHILD.tenantId, CHILD.rootExecutionId, seconds(30));

      expect(taken).toBeUndefined();
      expect(looks).toBe(2);
      expect(await rows()).toEqual([]);
      // given back, not left to expire: free at once, and no previous holder to name
      expect(next).toMatchObject({ holderInstanceId: "instance-1", leaseEpoch: 2 });
      expect(next?.takenOverFrom).toBeUndefined();
    },
  },
  {
    name: "a take of work already over asks the store for nothing",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const { events, rows } = leaseLogOn(clock);

      const taken = await executionLeasesOf(second, clock, { events }).tryHold(CHILD, {
        ...RECLAIM,
        isOver: () => Promise.resolve(true),
      });
      const firstLease = await first.acquire(CHILD.tenantId, CHILD.rootExecutionId, seconds(30));

      expect(taken).toBeUndefined();
      expect(await rows()).toEqual([]);
      // the key was never taken: the first acquire is its first lease
      expect(firstLease).toMatchObject({ leaseEpoch: 1 });
    },
  },
  {
    name: "a take whose look at its work fails goes on as before: taken, and a takeover recorded",
    run: async ({ clock, second }: Instances): Promise<void> => {
      const { events, rows } = leaseLogOn(clock);

      const taken = await executionLeasesOf(second, clock, { events }).tryHold(CHILD, {
        ...RECLAIM,
        isOver: () => Promise.reject(new Error("the queue did not answer")),
      });

      expect(taken).toMatchObject({ leaseExecutionId: "child-1", token: 1 });
      expect(await rows()).toMatchObject([
        { executionId: "child-1", reason: LeaseTakeoverReason.RemoteChild, token: 1 },
      ]);
      await taken?.release();
    },
  },
];
