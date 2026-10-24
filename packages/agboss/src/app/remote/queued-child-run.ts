import { runIdOf, type RunContext } from "../../core/run-context.js";
import { totalCost } from "../../finops/usage.js";
import { executionGraphOf } from "../../flow/runtime/build.js";
import { asRootRun, isExecutionState } from "../../flow/runtime/child-thread.js";
import type { ExecutionStateType } from "../../flow/runtime/state.js";
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
import { continuedExecutionBudgets } from "../../run/run-budgets.js";
import { streamConfig } from "../../run/stream-config.js";
import type { AppDeps } from "../app-deps.js";
import type { ChildRegistry } from "./child-registry.js";

/**
 * One queued child run on the instance that claimed it (#333 PR 2): its workflow's graph compiled
 * as a root graph on its own thread — the same graph an in-process child runs — with the run
 * context its parent's node would give it (its id, the conversation thread, its parents rebuilt from
 * the row), the tree's budgets read again from the ledger (its spend is recorded by its parent when
 * its step goes on, as for a local child), and the worker's signal. It ends at a finish (`Answered`)
 * or fails (`Failed`, its error's name, code and message); a child that rests at a pause fails —
 * the assembly refuses one that can pause (`[graph.remote-child-can-pause]`, until #333 PR 4).
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
  signal: AbortSignal,
): RunContext {
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
    tree: { parent, itemIndex: run.initial.child.itemIndex },
  };
}

/** Streams the child's graph to its end on its own thread; its last state. */
async function streamed(
  childDeps: GraphDeps<string>,
  rootDeps: AppDeps,
  run: RemoteChildRun,
  context: RunContext,
): Promise<{ readonly last?: ExecutionStateType; readonly rests: boolean }> {
  const { initial } = run;
  const budgets = await continuedExecutionBudgets(
    rootDeps,
    initial.budgets,
    totalCost(initial.usage),
  );
  const graph = executionGraphOf(childDeps, { budgets: budgets.meter });
  const identity = {
    threadId: context.threadId,
    tenantId: context.tenantId,
    runId: context.runId,
    input: context.input,
  };
  const base = streamConfig(rootDeps, identity, { signal: context.signal });
  const config = {
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
  let last: ExecutionStateType | undefined;
  await asRootRun(async () => {
    for await (const state of await graph.stream(initial, config))
      if (isExecutionState(state)) last = state;
  });
  const snapshot = await asRootRun(() => graph.getState(config));
  return { ...(last === undefined ? {} : { last }), rests: snapshot.next.length > 0 };
}

/** What a claimed child's run needs from its instance. */
export interface QueuedChildParts {
  readonly registry: ChildRegistry;
  readonly serde: Parameters<typeof decodedRun>[0];
}

/** Runs one claimed child to its end; how its row ends. */
export async function runQueuedChild(
  parts: QueuedChildParts,
  row: QueuedChildExecution,
  signal: AbortSignal,
): Promise<ChildExecutionEnd> {
  try {
    const root = parts.registry.rootOf(row.rootWorkflow);
    const childDeps = parts.registry.depsOf(row.workflow);
    if (root === undefined || childDeps === undefined)
      throw new QueuedChildError(
        `${row.workflow} (of ${row.rootWorkflow}) is not a workflow of this application`,
      );
    const run = await decodedRun(parts.serde, row.run);
    const context = runContextOf(run, row, parts.registry, root.deps, signal);
    const { rests } = await streamed(childDeps, root.deps, run, context);
    if (rests)
      throw new QueuedChildError(
        `${row.workflow} paused on another instance — a remote child cannot pause until #333 PR 4`,
      );
    return { status: ExecutionRecordStatus.Answered };
  } catch (error) {
    return { status: ExecutionRecordStatus.Failed, failure: failureTextOf(error) };
  }
}
