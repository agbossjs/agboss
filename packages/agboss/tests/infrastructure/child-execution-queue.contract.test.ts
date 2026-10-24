/**
 * #333 PR 2: `ChildExecutionQueueRepository` — a child is queued once and claimed once (of two
 * instances exactly one gets it), the deepest first, then the longest waiting; only its claimer
 * completes it; a tree's rows go with its root. One suite, run against the in-memory default (two
 * instances over one database) and `SqliteChildExecutionQueueRepository` (two on one file).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryChildExecutionQueueRepository,
  type ChildExecutionQueueRepository,
  type QueuedChildExecution,
} from "../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { SqliteChildExecutionQueueRepository } from "../../src/infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
import { seconds } from "../../src/units/index.js";
import { storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<ChildExecutionQueueRepository>({
  inMemory: ({ clock, application, database }) =>
    new InMemoryChildExecutionQueueRepository(clock, application, database),
  sqlite: ({ clock, application, connection }) =>
    new SqliteChildExecutionQueueRepository(connection(), clock, application),
});

const child = (
  executionId: string,
  fields: Partial<QueuedChildExecution> = {},
): QueuedChildExecution => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date("2026-01-05T09:00:00Z"),
  ...fields,
});

describe.each(kinds)("#333 PR 2: the queue contract ($name)", ({ twoInstances }) => {
  it("a child is queued once", async () => {
    const { first, second } = twoInstances();

    const saved = await Promise.all([
      first.saveIfAbsent(child("c-1")),
      second.saveIfAbsent(child("c-1")),
    ]);

    expect(saved.sort()).toEqual([false, true]);
    expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
      status: ExecutionRecordStatus.Queued,
      rootWorkflow: "items-workflow",
      depth: 2,
    });
  });

  it("claimed once: of two instances one gets it, with its id and time", async () => {
    const { clock, first, second } = twoInstances();
    await first.saveIfAbsent(child("c-1"));
    await clock.advance(seconds(5));

    const claims = await Promise.all([
      first.claimFirstByStatusQueuedOrderByDepthDesc(),
      second.claimFirstByStatusQueuedOrderByDepthDesc(),
    ]);

    const claimed = claims.filter((found) => found !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      status: ExecutionRecordStatus.Running,
      claimedAt: new Date("2026-01-05T09:00:05Z"),
    });
    expect(["instance-1", "instance-2"]).toContain(claimed[0]?.instanceId);
  });

  it("the deepest first, then the longest waiting", async () => {
    const { first } = twoInstances();
    await first.saveIfAbsent(child("late", { queuedAt: new Date("2026-01-05T09:00:02Z") }));
    await first.saveIfAbsent(child("early", { queuedAt: new Date("2026-01-05T09:00:01Z") }));
    await first.saveIfAbsent(
      child("deep", { depth: 3, queuedAt: new Date("2026-01-05T09:00:03Z") }),
    );

    const order = [
      await first.claimFirstByStatusQueuedOrderByDepthDesc(),
      await first.claimFirstByStatusQueuedOrderByDepthDesc(),
      await first.claimFirstByStatusQueuedOrderByDepthDesc(),
      await first.claimFirstByStatusQueuedOrderByDepthDesc(),
    ].map((found) => found?.executionId);

    expect(order).toEqual(["deep", "early", "late", undefined]);
  });

  it("only its claimer completes it, once", async () => {
    const { first, second } = twoInstances();
    await first.saveIfAbsent(child("c-1"));
    await first.claimFirstByStatusQueuedOrderByDepthDesc();
    const failed = { status: ExecutionRecordStatus.Failed, failure: '{"name":"E"}' } as const;

    expect(await second.completeByTenantIdAndExecutionId("default", "c-1", failed)).toBe(false);
    expect(await first.completeByTenantIdAndExecutionId("default", "c-1", failed)).toBe(true);
    expect(await first.completeByTenantIdAndExecutionId("default", "c-1", failed)).toBe(false);
    expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
      status: ExecutionRecordStatus.Failed,
      failure: '{"name":"E"}',
      instanceId: "instance-1",
    });
  });

  it("a tree's rows go with its root; another tree's and tenant's stay", async () => {
    const { first, second } = twoInstances();
    await first.saveIfAbsent(child("c-1"));
    await first.saveIfAbsent(child("c-2", { rootExecutionId: "root-2" }));
    await first.saveIfAbsent(child("c-3", { tenantId: "acme" }));

    await second.deleteAllByTenantIdAndRootExecutionId("default", "root-1");

    expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toBeUndefined();
    expect(await first.findByTenantIdAndExecutionId("default", "c-2")).toBeDefined();
    expect(await first.findByTenantIdAndExecutionId("acme", "c-3")).toBeDefined();
    await expect(first.ping()).resolves.toBeUndefined();
  });
});
