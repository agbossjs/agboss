import { z } from "zod";
import type { App } from "../../app/types.js";
import { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";

/**
 * What a test reads of a tree's pauses (#939): each pause's status and resolution, whether the
 * thread's paused run is still this tree's, and the answer log's entries (taken or not) — read
 * through the stores' contracts, so the same on every store.
 */
export const FaultPauseStateSchema = z.object({
  pauses: z.array(z.object({ status: z.string(), resolution: z.string().nullable() })),
  /** Whether the thread still keeps a paused run of this tree. */
  hasPausedRun: z.boolean(),
  log: z.array(
    z.object({
      isTaken: z.boolean(),
      resolution: z.string(),
      answeredBy: z.string().nullable(),
    }),
  ),
});

export type FaultPauseState = z.infer<typeof FaultPauseStateSchema>;

/** The tree's pause state as the pod's stores hold it now. */
export async function pauseStateOf(app: App, rootExecutionId: string): Promise<FaultPauseState> {
  const tenantId = "default";
  const pauses = app.resolve(PausedExecutionRepository);
  const records = await pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  const [first] = records;
  const stored =
    first === undefined
      ? undefined
      : await pauses.findByTenantIdAndThreadId(tenantId, first.threadId);
  const log = await app
    .resolve(ExecutionRecordRepository)
    .findPauseAnswersByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  return {
    pauses: records.map((pause) => ({
      status: pause.status,
      resolution: pause.resolution ?? null,
    })),
    hasPausedRun: stored?.run.runId === rootExecutionId,
    log: log.map((entry) => ({
      isTaken: entry.isTaken !== false,
      resolution: entry.resolution,
      answeredBy: entry.answeredBy ?? null,
    })),
  };
}
