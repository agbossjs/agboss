import { ExecutionCancelledError } from "../core/errors.js";
import { shownCallOf } from "../infrastructure/fenced-effect-key.js";
import { errorRecordOf } from "../core/error-record.js";
import { buildCostReport } from "../finops/usage.js";
import { compensationRecordsOf, type CompensationRecord } from "../flow/compensation.js";
import { DEFAULT_CONTEXT_VALUES } from "../flow/context/context-values.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "../infrastructure/execution-history.repository.js";
import type { TrustedMesh } from "../mesh/inbound-mesh.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AppDeps } from "./app-deps.js";
import type { ExecutionHistoryKeeper } from "./app-deps-parts.js";

export { historyKeeperOf, type ExecutionHistoryKeeper } from "./app-deps-parts.js";
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
  /**
   * The undo actions that ran, when they are not all in the checkpoint: a tree whose undo a
   * takeover finished without a pass (#340 PR 4) — what its `onExecutionError` lists (#484).
   */
  readonly compensations?: readonly CompensationRecord[];
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

/** The channels a record reads. */
type RecordedState = Pick<
  ExecutionStateType,
  | "start"
  | "startInput"
  | "startedAt"
  | "contexts"
  | "path"
  | "scope"
  | "outdatedValues"
  | "lastError"
  | "finish"
  | "output"
  | "usage"
  | "children"
  | "compensations"
  | "toolCalls"
  | "stepRecords"
>;

/** Those channels as a state before its first write holds them. */
const EMPTY_STATE: RecordedState = {
  start: "",
  startInput: undefined,
  startedAt: "",
  contexts: DEFAULT_CONTEXT_VALUES,
  path: [],
  scope: {},
  outdatedValues: [],
  lastError: null,
  finish: "",
  output: undefined,
  usage: [],
  children: [],
  compensations: [],
  toolCalls: [],
  stepRecords: [],
};

/** The root's last checkpoint state, every channel a record reads present. */
async function checkpointStateOf(deps: AppDeps, state: TreeState): Promise<RecordedState> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(state.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  return { ...EMPTY_STATE, ...(snapshot.values as Partial<ExecutionStateType>) };
}

/** Where a trusted mesh request came from (#398 PR 2): the claims its root kept. */
const originOf = (trusted: TrustedMesh | undefined) =>
  trusted === undefined ? {} : { origin: trusted.origin };

/** What the flow kept, as `{ record: true }` gives it, and where a trusted mesh request came from. */
const recordPartOf = (values: RecordedState) => ({
  path: values.path,
  scope: Object.values(values.scope),
  outdatedValues: values.outdatedValues,
  ...(values.lastError === null ? {} : { lastError: values.lastError }),
  spend: buildCostReport(values.usage),
  children: withChildPauses(values.children, []),
  pauses: [],
  compensations: compensationRecordsOf(values.compensations),
  toolCalls: values.toolCalls,
  steps: values.stepRecords,
  ...originOf(values.contexts.mesh?.trusted),
});

/** What it finished with; nothing unless it finished. */
const finishPartOf = (deps: AppDeps, values: RecordedState) =>
  values.finish === "" ? {} : { finish: nodeRecordIn(deps, values.finish), output: values.output };

/** Who and what the execution is: its ids, application and workflow. */
const identityOf = (deps: AppDeps, keeper: ExecutionHistoryKeeper, state: TreeState) => ({
  executionId: state.runId,
  rootExecutionId: state.runId,
  threadId: state.threadId,
  tenantId: state.tenantId,
  application: {
    name: keeper.application.name,
    version: keeper.application.version,
    instanceId: keeper.application.instanceId,
  },
  workflow: executionEventAt(state, deps).workflow,
});

/** When it started (its checkpoint's start; a tree from before #401: now) and, once ended, ended. */
function timesOf(values: RecordedState, status: ExecutionHistoryStatus, at: string) {
  const startedAt = values.startedAt === "" ? at : values.startedAt;
  return status === ExecutionHistoryStatus.Paused ? { startedAt } : { startedAt, endedAt: at };
}

/** The record of the tree as its checkpoint holds it, unmasked. */
function historyRecordOf(
  deps: AppDeps,
  keeper: ExecutionHistoryKeeper,
  state: TreeState,
  values: RecordedState,
  end: HistoryEnd,
): ExecutionHistoryRecord {
  return {
    ...recordPartOf(values),
    ...(end.compensations === undefined ? {} : { compensations: end.compensations }),
    ...identityOf(deps, keeper, state),
    status: end.status,
    ...timesOf(values, end.status, keeper.clock.now().toISOString()),
    start: nodeRecordIn(deps, values.start),
    input: values.startInput,
    ...finishPartOf(deps, values),
    contexts: { tenant: values.contexts.tenant, execution: values.contexts.execution },
    ...(end.error === undefined ? {} : { error: errorRecordOf(end.error) }),
  };
}

/** The tree's record with the pauses its tree resolved, masked like its traces. */
async function maskedRecordOf(
  keeper: ExecutionHistoryKeeper,
  record: ExecutionHistoryRecord,
): Promise<ExecutionHistoryRecord> {
  const answers = await keeper.answers.findPauseAnswersByTenantIdAndRootExecutionId(
    record.tenantId,
    record.executionId,
  );
  const calls = await keeper.outboundCalls?.findAllByTenantIdAndRootExecutionId(
    record.tenantId,
    record.executionId,
  );
  const answered = {
    ...record,
    pauses: answers,
    children: withChildPauses(record.children, answers),
    // its calls that left the system (#505), masked with the record: results and failure texts too
    ...(calls === undefined ? {} : { outboundCalls: calls.map(shownCallOf) }),
  };
  // the mask keeps the shape: every string masked, the contexts' sensitive fields hidden
  const masked = (await keeper.mask.traceData(answered)) as typeof answered;
  // the lease log's rows were masked when they were written (#501)
  const leaseEvents =
    await keeper.leaseEvents?.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      record.tenantId,
      record.executionId,
    );
  return leaseEvents === undefined ? masked : { ...masked, leaseEvents };
}

/** Saves the tree's record as it stands now, when the application keeps its history. */
export async function keepExecutionRecord(
  deps: AppDeps,
  state: TreeState,
  end: HistoryEnd,
): Promise<void> {
  const keeper = deps.executionHistory;
  if (keeper === undefined) return;
  try {
    const values = await checkpointStateOf(deps, state);
    const record = historyRecordOf(deps, keeper, state, values, end);
    await keeper.repository.save(await maskedRecordOf(keeper, record));
  } catch (error) {
    const text = `the history of execution ${state.runId} could not be saved: ${String(error)}`;
    deps.log.warn("execution-history.failed", text, {
      executionId: state.runId,
      tenantId: state.tenantId,
    });
  }
}
