import { Command } from "@langchain/langgraph";
import { isHandedOver } from "../handed-over.js";
import type { HeldExecutionLease } from "../execution-leases.js";
import { leasedDeps, leasedGraphDeps } from "../tree-ends.js";
import { runIdOf, type RunContext } from "../../core/run-context.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { executionGraphOf, type ExecutionGraph } from "../../flow/runtime/build.js";
import { asRootRun, isExecutionState } from "../../flow/runtime/child-thread.js";
import {
  decodedRun,
  parentOfRecord,
  type RemoteChildRun,
} from "../../flow/runtime/remote/remote-child-run.js";
import { failureTextOf } from "../../flow/runtime/remote/remote-failure.js";
import { standaloneContexts, tenantOfExecution } from "../../flow/context/runtime-contexts.js";
import type { GraphDeps } from "../../graph/deps.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type {
  ChildExecutionEnd,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import { drainRun, outcomeError } from "../../run/execute.js";
import { pausedLoopsOf, pausedUsageOf } from "../../run/paused.js";
import { continuedExecutionBudgets, recorder } from "../../run/run-budgets.js";
import { streamConfig } from "../../run/stream-config.js";
import { openPausesOf } from "../../run/waiting-pauses.js";
import type { AppDeps } from "../app-deps.js";
import type { ChildRegistry } from "./child-registry.js";

/**
 * One queued child run on the instance that claimed it (#333 PR 2, PR 4): its workflow's graph
 * compiled as a root graph on its own thread — the same graph an in-process child runs — under the
 * worker's lease in `ExecutionLeaseRepository` (`(tenantId, childExecutionId)`). A fresh child
 * streams from `initial`; a paused child re-queued by `app.resume` continues with `Command({ resume })`;
 * a child whose previous worker crashed or stopped past `shutdownTimeout` (S7) continues from its
 * last checkpoint on `<parentThreadId>/child/<id>` with `stream(null)`. A hand-over (`isHandedOver`)
 * returns `undefined` so the queue row stays `Running` for per-child recovery.
 */

class QueuedChildError extends Error {
  override name = "QueuedChildError";
}

/** The child's run context on this instance: its parents rebuilt, the worker's signal. */
function runContextOf(
  run: RemoteChildRun,
  row: QueuedChildExecution,
  registry: ChildRegistry,
  deps: AppDeps,
  at: { readonly signal: AbortSignal; readonly lease: HeldExecutionLease },
): RunContext {
  const { signal, lease } = at;
  const contexts = deps.contexts ?? standaloneContexts(deps.config);
  const values = run.initial.contexts;
  const parent = parentOfRecord(run.parent, {
    workflowOf: registry.workflowOf,
    componentOf: registry.componentOf,
    tenant: tenantOfExecution(contexts, values.tenant),
    values: values.execution,
    signal,
  });
  return {
    runId: runIdOf(row.executionId),
    threadId: run.threadId,
    signal,
    tenantId: row.tenantId,
    input: run.input,
    ...(run.ownerId === undefined ? {} : { ownerId: run.ownerId }),
    // the child's own lease (#471): its steps fence with it, never its parent's
    lease,
    tree: { parent, itemIndex: run.initial.child.itemIndex },
  };
}

/** Spend already in the ledger when a paused child is continued (`pausedLoopsOf` + reply calls). */
async function resumedSpendOf(
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

/** Builds the LangGraph config for the child's own thread. */
function childStreamConfig(
  childDeps: GraphDeps<string>,
  rootDeps: AppDeps,
  run: RemoteChildRun,
  context: RunContext,
) {
  const { initial } = run;
  const identity = {
    threadId: context.threadId,
    tenantId: context.tenantId,
    runId: context.runId,
    input: context.input,
  };
  const base = streamConfig(rootDeps, identity, { signal: context.signal });
  return {
    ...base,
    runName: childDeps.config.name,
    configurable: { ...base.configurable, run: context, thread_id: run.thread },
    metadata: {
      ...base.metadata,
      executionId: context.runId,
      parentExecutionId: initial.child.parentExecutionId,
      rootExecutionId: initial.child.rootExecutionId,
    },
  };
}

/** Interrupt ids waiting on `before`. */
const interruptIdsOf = (
  before: Awaited<ReturnType<ExecutionGraph["getState"]>>,
): readonly string[] =>
  before.tasks.flatMap((task) =>
    task.interrupts.flatMap((each) => (each.id === undefined ? [] : [each.id])),
  );

/** Streams the child's graph on its own thread; whether it rests at a pause. */
async function streamed(
  childDeps: GraphDeps<string>,
  rootDeps: AppDeps,
  row: QueuedChildExecution,
  run: RemoteChildRun,
  context: RunContext,
): Promise<{ readonly rests: boolean }> {
  const { initial, resume } = run;
  const config = childStreamConfig(childDeps, rootDeps, run, context);
  const reading = executionGraphOf(childDeps, {
    budgets: (await continuedExecutionBudgets(rootDeps, initial.budgets, totalCost(initial.usage)))
      .meter,
  });
  const before = await asRootRun(() => reading.getState(config));
  if (!isExecutionState(before.values)) {
    const budgets = await continuedExecutionBudgets(
      rootDeps,
      initial.budgets,
      totalCost(initial.usage),
    );
    const graph = executionGraphOf(childDeps, { budgets: budgets.meter });
    const record = recorder(budgets.meter, []);
    await asRootRun(async () =>
      drainRun(await graph.stream(initial, config), record, initial.usage),
    );
    const after = await asRootRun(() => graph.getState(config));
    return { rests: after.next.length > 0 };
  }
  if (before.next.length === 0) return { rests: false };
  const interrupts = interruptIdsOf(before);
  const isResuming = resume !== undefined && interrupts.some((id) => id in resume);
  if (interrupts.length > 0 && !isResuming) return { rests: true };
  if (resume === undefined) {
    const text = `execution ${row.executionId} is recovered: it continues from its last checkpoint`;
    rootDeps.log.warn("execution.recovered", text, {
      executionId: row.executionId,
      tenantId: row.tenantId,
    });
  }
  const spent = isResuming
    ? await resumedSpendOf(reading, rootDeps, row, run.thread, before.values.usage, resume)
    : before.values.usage;
  const budgets = await continuedExecutionBudgets(rootDeps, initial.budgets, totalCost(spent));
  const graph = executionGraphOf(childDeps, { budgets: budgets.meter });
  const record = recorder(budgets.meter, []);
  const input = isResuming ? new Command({ resume }) : null;
  await asRootRun(async () => drainRun(await graph.stream(input, config), record, spent));
  const after = await asRootRun(() => graph.getState(config));
  return { rests: after.next.length > 0 };
}

/** What a claimed child's run needs from its instance. */
export interface QueuedChildParts {
  readonly registry: ChildRegistry;
  readonly serde: Parameters<typeof decodedRun>[0];
}

/** Runs one claimed child pass under `lease`; `undefined` when handed over (row stays `Running`). */
export async function runQueuedChild(
  parts: QueuedChildParts,
  row: QueuedChildExecution,
  lease: HeldExecutionLease,
  signal: AbortSignal,
): Promise<ChildExecutionEnd | undefined> {
  try {
    const root = parts.registry.rootOf(row.rootWorkflow);
    const rawChildDeps = parts.registry.depsOf(row.workflow);
    if (root === undefined || rawChildDeps === undefined)
      throw new QueuedChildError(
        `${row.workflow} (of ${row.rootWorkflow}) is not a workflow of this application`,
      );
    const rootDeps = leasedDeps(root.deps, lease);
    const childDeps = leasedGraphDeps(rawChildDeps, lease);
    const run = await decodedRun(parts.serde, row.run);
    const context = runContextOf(run, row, parts.registry, rootDeps, { signal, lease });
    const { rests } = await streamed(childDeps, rootDeps, row, run, context);
    return { status: rests ? ExecutionRecordStatus.Paused : ExecutionRecordStatus.Answered };
  } catch (error) {
    const cause = outcomeError(error, signal);
    if (isHandedOver(cause)) return undefined;
    return { status: ExecutionRecordStatus.Failed, failure: failureTextOf(cause) };
  }
}
