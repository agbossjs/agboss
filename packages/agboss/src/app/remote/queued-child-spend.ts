import type { UsageRecord } from "../../finops/usage.js";
import type { ExecutionGraph } from "../../flow/runtime/build.js";
import { asRootRun } from "../../flow/runtime/child-thread.js";
import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import { pausedLoopsOf, pausedUsageOf } from "../../run/paused.js";
import { openPausesOf } from "../../run/waiting-pauses.js";
import type { AppDeps } from "../app-deps.js";

/** Spend already in the ledger when a paused child is continued (`pausedLoopsOf` + reply calls). */
export async function resumedSpendOf(
  graph: ExecutionGraph,
  rootDeps: AppDeps,
  row: QueuedChildExecution,
  thread: string,
  flowUsage: readonly UsageRecord[],
  resume: Readonly<Record<string, string>>,
): Promise<readonly UsageRecord[]> {
  const pause = rootDeps.pause;
  if (pause === undefined) return flowUsage;
  const answering = new Set(Object.values(resume));
  const tree = { tenantId: row.tenantId, runId: row.rootExecutionId };
  const isOpen = await openPausesOf(pause.pauses, tree, { answering });
  const loops = await asRootRun(() => pausedLoopsOf(graph, pause.checkpointer, thread, isOpen));
  const records = await pause.pauses.findAllByTenantIdAndRootExecutionId(
    row.tenantId,
    row.rootExecutionId,
  );
  const replies = records
    .filter((item) => answering.has(item.pauseId))
    .flatMap((item) => item.answer?.usage ?? []);
  return [...pausedUsageOf(flowUsage, loops), ...replies];
}
