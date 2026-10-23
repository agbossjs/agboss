import { ExecutionCancelledError } from "../core/errors.js";
import { errorRecordOf } from "../core/error-record.js";
import { buildCostReport } from "../finops/usage.js";
import { compensationRecordsOf } from "../flow/compensation.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "../infrastructure/execution-history.repository.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AppDeps } from "./app-deps.js";
import { executionEventAt } from "./run-events.js";
import type { TreeState } from "./tree-move-types.js";
import { ExecutionStatus } from "./types.js";

/**
 * The history of root executions (#401 PR 1): when the application keeps it
 * (`executionRecordRetention`), a root's `ExecutionHistoryRecord` is saved each time its tree rests
 * paused and once it ends — finished, failed or cancelled — built from its last checkpoint (any
 * instance can: the start time and contexts are in it), masked like its traces (the application's
 * and the workflow's PII policies, the contexts' `sensitive` fields hidden). A failed save is a
 * warning in the log (`execution-history.failed`), never the execution's failure; work handed over
 * (a lost lease, the app's stop) saves nothing — the next holder does.
 */

/** How the tree stands now: its status, and the error that ended it. */
export interface HistoryEnd {
  readonly status: ExecutionHistoryStatus;
  readonly error?: unknown;
}

/** How a tree whose pass returned stands: finished, or resting paused. */
export const historyRestOf = (status: ExecutionStatus): HistoryEnd => ({
  status:
    status === ExecutionStatus.Finished
      ? ExecutionHistoryStatus.Finished
      : ExecutionHistoryStatus.Paused,
});

/** How an error ended a tree: a cancel, or a failure. */
export const historyEndOf = (error: unknown): HistoryEnd => ({
  status:
    error instanceof ExecutionCancelledError
      ? ExecutionHistoryStatus.Cancelled
      : ExecutionHistoryStatus.Failed,
  error,
});

/** The root's last checkpoint state (its flow's own state). */
async function checkpointStateOf(
  deps: AppDeps,
  state: TreeState,
): Promise<Partial<ExecutionStateType>> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(state.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  return snapshot.values as Partial<ExecutionStateType>;
}

/** Where a trusted mesh request came from (#398 PR 2): kept in the root's contexts. */
function originOf(values: Partial<ExecutionStateType>) {
  const origin = values.contexts?.mesh?.trusted?.origin;
  return origin === undefined ? {} : { origin };
}

/** The record's own part: what the flow kept, as `{ record: true }` gives it. */
const recordPartOf = (values: Partial<ExecutionStateType>) => ({
  path: values.path ?? [],
  scope: Object.values(values.scope ?? {}),
  outdatedValues: values.outdatedValues ?? [],
  ...(values.lastError === null || values.lastError === undefined
    ? {}
    : { lastError: values.lastError }),
  spend: buildCostReport(values.usage ?? []),
  children: withChildPauses(values.children ?? [], []),
  pauses: [],
  compensations: compensationRecordsOf(values.compensations),
  toolCalls: values.toolCalls ?? [],
  steps: values.stepRecords ?? [],
  ...originOf(values),
});

/** What it finished with; nothing unless it finished. */
const finishPartOf = (deps: AppDeps, values: Partial<ExecutionStateType>) =>
  values.finish === undefined || values.finish === ""
    ? {}
    : { finish: nodeRecordIn(deps, values.finish), output: values.output };

/** Who and what the execution is: its ids, application and workflow. */
function identityOf(deps: AppDeps, state: TreeState) {
  const application = deps.contexts?.application;
  return {
    executionId: state.runId,
    rootExecutionId: state.runId,
    threadId: state.threadId,
    tenantId: state.tenantId,
    application: {
      name: application?.name ?? deps.config.name,
      version: application?.version ?? deps.config.version,
      instanceId: application?.instanceId ?? "",
    },
    workflow: executionEventAt(state, deps).workflow,
  };
}

/** When it started (the checkpoint's start; a tree from before #401: now) and, once ended, ended. */
function timesOf(values: Partial<ExecutionStateType>, end: HistoryEnd & { readonly at: string }) {
  const startedAt =
    values.startedAt === undefined || values.startedAt === "" ? end.at : values.startedAt;
  return end.status === ExecutionHistoryStatus.Paused
    ? { startedAt }
    : { startedAt, endedAt: end.at };
}

/** The record of the tree as its checkpoint holds it, unmasked. */
function historyRecordOf(
  deps: AppDeps,
  state: TreeState,
  values: Partial<ExecutionStateType>,
  end: HistoryEnd & { readonly at: string },
): ExecutionHistoryRecord {
  return {
    ...recordPartOf(values),
    ...identityOf(deps, state),
    status: end.status,
    ...timesOf(values, end),
    start: nodeRecordIn(deps, values.start ?? ""),
    input: values.startInput,
    ...finishPartOf(deps, values),
    contexts: {
      tenant: values.contexts?.tenant ?? {},
      execution: values.contexts?.execution ?? {},
    },
    ...(end.error === undefined ? {} : { error: errorRecordOf(end.error) }),
  };
}

/** The tree's record with the pauses its tree resolved, masked like its traces. */
async function maskedRecordOf(
  deps: AppDeps,
  record: ExecutionHistoryRecord,
): Promise<ExecutionHistoryRecord> {
  const answers =
    (await deps.pause?.answers.findPauseAnswersByTenantIdAndRootExecutionId(
      record.tenantId,
      record.executionId,
    )) ?? [];
  const answered = {
    ...record,
    pauses: answers,
    children: withChildPauses(record.children, answers),
  };
  const mask = deps.pii?.observability;
  // the mask keeps the shape: every string masked, the contexts' sensitive fields hidden
  return mask === undefined ? answered : ((await mask.traceData(answered)) as typeof answered);
}

/** Saves the tree's record as it stands now, when the application keeps its history. */
export async function keepExecutionRecord(
  deps: AppDeps,
  state: TreeState,
  end: HistoryEnd,
): Promise<void> {
  const history = deps.executionHistory;
  if (history === undefined) return;
  try {
    const values = await checkpointStateOf(deps, state);
    const at = (deps.clock?.now() ?? new Date(0)).toISOString();
    const record = historyRecordOf(deps, state, values, { ...end, at });
    await history.save(await maskedRecordOf(deps, record));
  } catch (error) {
    const text = `the history of execution ${state.runId} could not be saved: ${String(error)}`;
    deps.log.warn("execution-history.failed", text, {
      executionId: state.runId,
      tenantId: state.tenantId,
    });
  }
}
