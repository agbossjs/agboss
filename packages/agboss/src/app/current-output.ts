import { buildCostReport } from "../finops/usage.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { PauseStatus } from "../infrastructure/paused-execution.repository.js";
import { NotPausedError } from "../run/resume-agent.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { RunDeps } from "../run/types.js";
import type { PausedRunBook } from "./paused-runs.js";
import type { ThreadKey } from "./live-runs.js";
import { runResultOf } from "./result.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";

/**
 * Where a tree is now, for a resume whose decision another holder took (#267, Q58): paused again
 * (the stored pause), or finished (its last checkpoint) — read from the shared stores, so it holds
 * whichever instance moved the tree. A tree dropped by a cancel meanwhile → `NotPausedError`.
 */
export async function currentOutputOf(
  deps: RunDeps<string>,
  paused: PausedRunBook,
  tree: ThreadKey & { readonly runId: string },
): Promise<ExecutionOutput> {
  const stored = await paused.find(tree);
  if (stored?.status === PauseStatus.Pending && stored.run.runId === tree.runId) {
    return runResultOf(stored.run, false);
  }
  const snapshot = await readingGraphOf(deps).getState(runConfig(tree.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const state = snapshot.values as Partial<ExecutionStateType>;
  if (snapshot.next.length > 0 || state.finish === undefined || state.finish === "") {
    throw new NotPausedError(`Thread "${tree.threadId}" has no paused run`);
  }
  return {
    status: ExecutionStatus.Finished,
    threadId: tree.threadId,
    tenantId: tree.tenantId,
    runId: tree.runId,
    path: state.path ?? [],
    spend: buildCostReport(state.usage ?? []),
    launches: state.launches ?? [],
    finish: { name: state.finish },
    output: state.output,
  };
}
