import { ChildExecutionQueueRepository, ExecutionLeaseEventKind } from "../../../src/index.js";
import type { QueuedChildExecution } from "../../../src/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import {
  InMemoryDatabase,
  treeKeyOf,
  type ExecutionLeaseRow,
} from "../../../src/infrastructure/in-memory-database.js";
import type { ItemDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";

/**
 * #520 — what the tests of finished work read: the instances, the stores they share, a child's
 * row and lease, and the takeovers the lease log records of one execution.
 */

export const item = (name: string, outcome: ItemDto["outcome"] = "ok"): ItemDto => ({
  name,
  delay: 0,
  outcome,
});

/** Both instances, the second ready first: its worker claims what the first queues. */
export async function bothReady(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [a, b] = apps;
  if (a === undefined || b === undefined) throw new Error("the test runs two instances");
  await b.ready();
  await a.ready();
  return [a, b];
}

/** The stores the test's instances share (the in-memory queue's own, read as it is). */
export function databaseOf(app: TestApp): InMemoryDatabase {
  const database: unknown = Reflect.get(app.resolve(ChildExecutionQueueRepository), "database");
  if (!(database instanceof InMemoryDatabase)) throw new Error("the test runs on in-memory stores");
  return database;
}

/** The one queued child of the test, as the shared store keeps it. */
export function childOf(app: TestApp): QueuedChildExecution {
  const [row] = [...databaseOf(app).childQueue.values()];
  if (row === undefined) throw new Error("no child is queued");
  return row;
}

/** The status of `child`'s row now (`undefined` once its tree removed it). */
export const statusOf = (app: TestApp, child: QueuedChildExecution): string | undefined =>
  databaseOf(app).childQueue.get(treeKeyOf(child.tenantId, child.executionId))?.status;

/** The stored lease of the tree or child `executionId`. */
export const leaseRowOf = (app: TestApp, executionId: string): ExecutionLeaseRow | undefined =>
  databaseOf(app).executionLeases.get(treeKeyOf("default", executionId));

/** The takeovers of `executionId`'s own lease in the lease log of the tree `rootExecutionId`. */
export async function takeoversOf(
  app: TestApp,
  rootExecutionId: string,
  executionId: string,
): Promise<readonly unknown[]> {
  const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId });
  return rows.filter(
    (row) => row.kind === ExecutionLeaseEventKind.Takeover && row.executionId === executionId,
  );
}
