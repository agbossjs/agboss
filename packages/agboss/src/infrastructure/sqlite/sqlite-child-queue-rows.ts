import { z } from "zod";
import { ChildPlacement } from "../../flow/child-placement.js";
import type { QueuedChildExecution } from "../child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../execution-record.repository.js";

/** The rows of `child_execution_queue`, as `SqliteChildExecutionQueueRepository` reads them. */

const STATUSES = Object.values(ExecutionRecordStatus) as [
  ExecutionRecordStatus,
  ...ExecutionRecordStatus[],
];

const PLACEMENTS = Object.values(ChildPlacement) as [ChildPlacement, ...ChildPlacement[]];

const QueueRow = z.object({
  tenant_id: z.string(),
  execution_id: z.string(),
  root_execution_id: z.string(),
  parent_execution_id: z.string(),
  root_workflow: z.string(),
  workflow: z.string(),
  depth: z.number(),
  status: z.enum(STATUSES),
  run: z.string(),
  queued_at: z.number(),
  instance_id: z.string().nullable(),
  claimed_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  failure: z.string().nullable(),
  placement: z.enum(PLACEMENTS).nullable(),
  exclude_instance_id: z.string().nullable(),
});

export const dateOf = (millis: number | null): Date | undefined =>
  millis === null ? undefined : new Date(millis);

/** A row as the contract gives it back. */
export function childOf(row: unknown): QueuedChildExecution {
  const parsed = QueueRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    executionId: parsed.execution_id,
    rootExecutionId: parsed.root_execution_id,
    parentExecutionId: parsed.parent_execution_id,
    rootWorkflow: parsed.root_workflow,
    workflow: parsed.workflow,
    depth: parsed.depth,
    status: parsed.status,
    run: parsed.run,
    queuedAt: new Date(parsed.queued_at),
    instanceId: parsed.instance_id ?? undefined,
    claimedAt: dateOf(parsed.claimed_at),
    endedAt: dateOf(parsed.ended_at),
    failure: parsed.failure ?? undefined,
    placement: parsed.placement ?? undefined,
    excludeInstanceId: parsed.exclude_instance_id ?? undefined,
  };
}

export const DepthRow = z.object({
  queued: z.number(),
  running: z.number(),
  oldest: z.number().nullable(),
});
