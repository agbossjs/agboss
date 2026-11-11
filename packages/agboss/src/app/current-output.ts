import { compensationRecordsOf } from "../flow/compensation.js";
import { buildCostReport } from "../finops/usage.js";
import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { PauseStatus } from "../infrastructure/paused-execution.repository.js";
import type { AgentExecutionOutput } from "../run/types.js";
import { NotPausedError } from "../run/resume-agent.js";
import { runConfig } from "../run/paused.js";
import { waitingPauseOf } from "../run/waiting-pauses.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AgentExecutionDeps } from "../run/types.js";
import type { PausedRunBook } from "./paused-runs.js";
import type { ThreadKey } from "./live-runs.js";
import { runResultOf, withPauseAnswers } from "./result.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { AppDeps } from "./app-deps.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * The stored run with only the pauses still pending now (another call may have answered some),
 * each as its record says — its kind, step and ask (#801: a run stored before 0.1.1 lists `agent`).
 */
export async function stillPending(
  deps: Pick<AgentExecutionDeps<string>, "pause">,
  run: AgentExecutionOutput,
): Promise<AgentExecutionOutput> {
  const records =
    (await deps.pause?.pauses.findAllByTenantIdAndRootExecutionId(run.tenantId, run.runId)) ?? [];
  const byId = new Map(records.map((record) => [record.pauseId, record]));
  const pending = run.pending.flatMap((listed) => {
    const record = byId.get(listed.pauseId);
    return record?.status === PauseStatus.Pending ? [waitingPauseOf(record)] : [];
  });
  return { ...run, pending };
}

/** What a finished execution's state lists: its launches, children and handled failures. */
const recordsOf = (state: Partial<ExecutionStateType>) => ({
  launches: state.launches ?? [],
  children: withChildPauses(state.children ?? [], []),
  handledErrors: state.handledErrors ?? [],
  compensations: compensationRecordsOf(state.compensations),
  toolCalls: state.toolCalls ?? [],
});

/**
 * Where a tree is now, for a resume whose decision another holder took (#267, Q58): paused again
 * (the stored run, with the pauses still pending), or finished (its last checkpoint) — read from the
 * shared stores, so it holds whichever instance moved the tree. A tree dropped by a cancel
 * meanwhile → `NotPausedError`.
 */
export async function currentOutputOf(
  deps: AgentExecutionDeps<string>,
  paused: PausedRunBook,
  tree: ThreadKey & { readonly runId: string },
): Promise<ExecutionOutput> {
  const stored = await paused.find(tree);
  if (stored?.run.runId === tree.runId)
    return withPauseAnswers(
      runResultOf(await stillPending(deps, stored.run), false, (name) => nodeRecordIn(deps, name)),
      deps,
    );
  const snapshot = await readingGraphOf(deps).getState(runConfig(tree.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const state = snapshot.values as Partial<ExecutionStateType>;
  if (snapshot.next.length > 0 || state.finish === undefined || state.finish === "") {
    throw new NotPausedError(`Thread "${tree.threadId}" has no paused run`);
  }
  return withPauseAnswers(
    {
      status: ExecutionStatus.Finished,
      threadId: tree.threadId,
      tenantId: tree.tenantId,
      executionId: tree.runId,
      path: state.path ?? [],
      spend: buildCostReport(state.usage ?? []),
      ...recordsOf(state),
      pending: [],
      finish: nodeRecordIn(deps, state.finish),
      output: state.output,
    },
    deps,
  );
}

/** What a resume holds once it took the tree's lease: the lease, and the pause it answered. */
export interface ResumeTake {
  readonly lease: Pick<HeldExecutionLease, "release">;
  readonly pauseId: string;
}

/**
 * A resume's take of a tree whose root's record ended without a finish — failed (a cancel too) or
 * guarded — is refused (#901): final, no pass moves the tree again, though the answer the resume
 * recorded may still be `Resolved` (a drain took it and its pass stopped on a cancel) — the lease
 * given back, `NotPausedError`, as for a resume that lost its pause to a cancel.
 */
export async function refusedIfFailed(
  deps: AppDeps,
  state: TreeState,
  take: ResumeTake,
): Promise<void> {
  // the root's record by its id on its thread (`rootRecordOf`, whose module loads with an end)
  const record = await deps.terns.findByTenantIdAndRunId(state.tenantId, state.runId);
  const status = record?.threadId === state.threadId ? record.status : undefined;
  if (status !== ExecutionRecordStatus.Failed && status !== ExecutionRecordStatus.Guarded) return;
  await take.lease.release();
  throw new NotPausedError(
    `pause ${take.pauseId} was answered, but its tree ended before its answer ran`,
  );
}
