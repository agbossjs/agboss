import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";

/** A child of `root-1` queued at the suite's start, depth 2 — with `fields` over it. */
export const queuedChild = (
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
