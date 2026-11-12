/**
 * #923 — a child whose lease another live worker holds is refused, not retried at store speed: the
 * refused claim goes back to the queue and no instance looks again before one `Clock` second has
 * passed (two instances woke each other with every re-queue, hundreds of claim → refused take →
 * re-queue rounds a second against the queue's and the lease store's backends); the sweep stays the
 * safety net.
 */
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { childRegistryOf } from "../../src/app/remote/child-registry.js";
import {
  startChildWorkers,
  type ChildWorkerParts,
  type ChildWorkers,
} from "../../src/app/remote/child-workers.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { remoteChildSignals } from "../../src/flow/runtime/remote/remote-child-signals.js";
import {
  InMemoryChildExecutionQueueRepository,
  type QueuedChildExecution,
} from "../../src/infrastructure/child-execution-queue.repository.js";
import { SystemClock, type Clock } from "../../src/infrastructure/clock.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SILENT_LOG } from "../../src/infrastructure/logger.js";
import { VirtualClock } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";

const ROW: QueuedChildExecution = {
  tenantId: "default",
  executionId: "child-1",
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "root",
  workflow: "child",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date(0),
};

/** A turn of the event loop: any backend's round trip (a spin of instant answers would starve timers). */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
const settleReal = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The queue as a backend answers it: after a turn. */
class RoundTripQueue extends InMemoryChildExecutionQueueRepository {
  override async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<
    QueuedChildExecution | undefined
  > {
    await turn();
    return super.claimFirstByStatusQueuedOrderByDepthDesc();
  }

  override async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    await turn();
    return super.findByTenantIdAndExecutionId(tenantId, executionId);
  }

  override async saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    await turn();
    return super.saveIfAbsent(child);
  }
}

/** The lease store of one instance that counts its takes of the child's lease, after a turn. */
class CountingLeases extends InMemoryExecutionLeaseRepository {
  static takes = 0;

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Parameters<InMemoryExecutionLeaseRepository["acquire"]>[2],
  ): Promise<ExecutionLease | undefined> {
    await turn();
    CountingLeases.takes += 1;
    return super.acquire(tenantId, rootExecutionId, duration);
  }
}

describe("#923 AC2: a refused child lease take backs off on the clock", () => {
  const started: ChildWorkers[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((workers) => workers.stop()));
  });

  /** Two instances of one process, the child's lease held by a third worker (another process). */
  async function twoInstancesOf(clock: Clock): Promise<void> {
    CountingLeases.takes = 0;
    const database = new InMemoryDatabase();
    const instance = (instanceId: string) =>
      applicationContextOf({
        ...{ name: "refused-application", version: "1.0.0", instanceId },
        ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
      });
    const storeClock = storeClockOf(clock);
    const holder = new InMemoryExecutionLeaseRepository(
      storeClock,
      instance("elsewhere"),
      database,
    );
    await holder.acquire(ROW.tenantId, ROW.executionId, seconds(3600));
    await new RoundTripQueue(clock, instance("instance-1"), database).saveIfAbsent(ROW);
    for (const instanceId of ["instance-1", "instance-2"]) {
      const context = instance(instanceId);
      const parts: ChildWorkerParts = {
        queue: new RoundTripQueue(clock, context, database),
        leases: executionLeasesOf(new CountingLeases(storeClock, context, database), clock),
        trees: new InMemoryExecutionTreeRepository(database),
        registry: childRegistryOf([]),
        serde: new MemorySaver().serde,
        clock,
        log: SILENT_LOG,
        interruption: new AbortController().signal,
      };
      started.push(startChildWorkers(parts));
    }
  }

  it("on a VirtualClock: no take without the clock moving, at most one per instance per second", async () => {
    const clock = new VirtualClock();
    await twoInstancesOf(clock);
    await settleReal(300);
    const first = CountingLeases.takes;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(2);

    await settleReal(300);
    expect(CountingLeases.takes).toBe(first);

    for (let second = 1; second <= 5; second += 1) {
      await clock.advance(seconds(1));
      await settleReal(100);
      expect(CountingLeases.takes).toBeLessThanOrEqual(first + 2 * second);
    }
    remoteChildSignals.queued();
    await settleReal(100);
    expect(CountingLeases.takes).toBeLessThanOrEqual(first + 2 * 5 + 2);
  });

  it("on the system clock: a few takes in two seconds, not a spin", async () => {
    await twoInstancesOf(new SystemClock());
    await settleReal(2000);
    expect(CountingLeases.takes).toBeLessThanOrEqual(8);
  });
});
