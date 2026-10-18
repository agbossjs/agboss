import { randomUUID } from "node:crypto";
import { rememberAppWorkflow } from "./app-workflow.js";
import { checkThreadAccess, checkThreadOwner, type ThreadAccess } from "../run/thread.js";
import { runOpenedAgent } from "../run/run-agent.js";
import { openExecutionBudgets } from "../run/run-budgets.js";
import { runVersions } from "../run/versions.js";
import type { AssembledWorkflow } from "../workflow.js";
import {
  createWorkflowDeps,
  type AppDeps,
  type AppDepsOptions,
  type WorkflowDepsParts,
} from "./app-deps.js";
import { pausedRunBook } from "./paused-runs.js";
import { UnknownToolError } from "./parts.js";
import { cancelledOutcome, LiveRuns, runOptionsOf } from "./live-runs.js";
import { executionLeasesOf } from "./execution-leases.js";
import { treeMovesOf } from "./tree-moves.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import {
  contextValuesOf,
  defaultTenantOf,
  standaloneContexts,
} from "../flow/context/runtime-contexts.js";
import { admitRequest, observeCancelledPause } from "./run-events.js";
import { checkedStart, textStartOf } from "./starts.js";
import type { App, ExecutionOptions, ExecutionOutput } from "./types.js";
import type { RunOperation } from "../core/observability.js";
import { ApplicationStoppingError } from "./application-stopping.js";
import { recoverRootOf, type RecoverRoot } from "./recover-root.js";

export { NotAWorkflowStartError } from "./starts.js";

/**
 * `createApp` options: the environment, a profile on top of each workflow, and any external part
 * (models, MCP transports) instead of its default. Infrastructure is not an option: it is listed in
 * `@Application({ providers })`.
 */
export interface AppOptions extends Omit<AppDepsOptions, "environment"> {
  /**
   * The environment: `environments/<env>.environment.ts` next to the application file (default
   * `dev`) — of an application that declares `@Application({ environment })`.
   */
  readonly env?: string | undefined;
  /** `profiles/<workflow>/<profile>.yaml` under `profileRoot` (default: the working directory). */
  readonly profile?: string | undefined;
  readonly profileRoot?: string;
}

/** Why an execution or a resume is refused once `app.close()` has begun. */
const STOPPING = "the app is stopping: app.close() was called, no new execution is accepted";

/**
 * One workflow of an application instance, built, with the parts it was built from (the testing
 * toolkit's slices read them): `refuse()` stops it taking new executions, `settled()` waits for
 * the running ones, `interrupt(reason)` stops what still runs (the application's graceful stop),
 * `recover` continues one of its interrupted roots (the recovery sweep, #265 S30).
 */
export interface BuiltApp {
  readonly app: App;
  readonly deps: AppDeps;
  readonly bundle: AssembledWorkflow;
  readonly refuse: () => void;
  readonly settled: () => Promise<void>;
  readonly interrupt: (reason: ApplicationStoppingError) => void;
  readonly recover: RecoverRoot;
}

/** One workflow of an application over already assembled parts (a profile applied). */
// eslint-disable-next-line max-lines-per-function
export async function buildApp(
  bundle: AssembledWorkflow,
  options: AppDepsOptions,
  parts: WorkflowDepsParts,
): Promise<BuiltApp> {
  const deps = await createWorkflowDeps(bundle, options, parts);
  const current = {
    workflowVersion: deps.config.version,
    configHash: runVersions(deps).configHash,
  };
  const policy = bundle.onIncompatibleResume;
  const paused = pausedRunBook(parts.infrastructure.pausedExecutions, current, policy);
  const live = new LiveRuns();
  const { executionLeases, executionTrees: trees } = parts.infrastructure;
  const leases = executionLeasesOf(executionLeases, parts.infrastructure.clock);
  const moves = treeMovesOf({ deps, live, paused, leases, trees });
  const owned = (access: ThreadAccess) => checkThreadOwner(deps.terns, deps.config.name, access);
  const known = (access: ThreadAccess) => checkThreadAccess(deps.terns, deps.config.name, access);
  const contexts = deps.contexts ?? standaloneContexts(deps.config);
  let closed = false;
  let released = false;
  const admit = <T>(
    operation: RunOperation,
    thread: string | undefined,
    checks: () => Promise<T>,
  ) => admitRequest(deps.observer, { operation, threadId: thread }, checks);
  /** From `app.close()` on (`onStop`), no new execution is accepted; running ones go on (#261). */
  const accepting = (): void => {
    if (closed) throw new ApplicationStoppingError(STOPPING);
  };
  const app: App = {
    name: deps.config.name,
    version: deps.config.version,
    warnings: deps.warnings,
    models: deps.models,
    textStart: textStartOf(bundle.graph),
    execute: async (start, input, ...[given]) => {
      const call: ExecutionOptions = given ?? {};
      const checked = await admit("execute", call.threadId, async () => {
        accepting();
        const valid = checkedStart(start, input, bundle.graph);
        // the contexts' values, checked before the first step and frozen (#261)
        const values = contextValuesOf(contexts, call);
        const { tenantId } = values.tenant;
        if (call.threadId !== undefined)
          await known({ tenantId, threadId: call.threadId, ownerId: call.ownerId });
        return { ...valid, contexts: values };
      });
      const { tenantId } = checked.contexts.tenant;
      // one id for the whole run: its observer events, `executionContext.executionId`, its Tern and its result
      const runId = deps.newRunId?.() ?? randomUUID();
      const { contexts: values } = checked;
      // before the first step (#261): each budget's `maxSpend()` once; one exhausted rejects it —
      // before anything is written: no thread, no record, no checkpoint
      const budgets = await admit("execute", call.threadId, () =>
        openExecutionBudgets(deps, {
          executionId: runId,
          threadId: call.threadId,
          start: checked.name,
          ownerId: call.ownerId,
          signal: call.signal,
          contexts: values,
        }),
      );
      // the thread is known before the run starts, so `cancel(threadId)` reaches a new one too
      const threadId =
        call.threadId ?? (await deps.terns.createThread(deps.config.name, tenantId, call.ownerId));
      await deps.observer.onWorkflowStart({ runId, threadId });
      const begun = { start: checked.name, input: checked.input, threadId };
      const result = await moves.first({ runId, threadId, tenantId }, call, (moving, signal) =>
        runOpenedAgent(
          begun,
          moving,
          { ...runOptionsOf(call, signal), runId, contexts: values },
          budgets,
        ),
      );
      // the generated `WorkflowStarts` types the output; at run time it is the finish's validated DTO
      return result as ExecutionOutput<never>;
    },
    cancel: async (threadId, options = {}) => {
      const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
      // another tenant's thread does not exist for the caller (#261): `UnknownThreadError`
      await admit("cancel", threadId, () => known({ ...thread, ownerId: options.ownerId }));
      const running = live.abort(thread);
      const waiting = await paused.drop(thread);
      // a running resume completes its own Tern when the abort stops it
      if (waiting !== undefined && !running) {
        await trees.deleteAllInTree({ tenantId: thread.tenantId, rootExecutionId: waiting.runId });
        await deps.terns.complete(waiting.ternId, cancelledOutcome(waiting));
        await observeCancelledPause(deps.observer, { runId: waiting.runId, threadId });
      }
      return { cancelled: running || waiting !== undefined };
    },
    // two phases (Q58): the decision recorded (Pending → Resolved, atomic), then the tree moved
    resume: async (threadId, decision, call = {}) => {
      const thread = { tenantId: call.tenantId ?? DEFAULT_TENANT_ID, threadId };
      const run = await admit("resume", threadId, async () => {
        accepting();
        await owned({ ...thread, ownerId: call.ownerId });
        return paused.resolve(thread, decision);
      });
      return moves.resumed(run, call);
    },
    close: async () => {
      closed = true;
      if (released) return;
      released = true;
      await deps.close(() => live.settled());
    },
    resolve: (token) => deps.container.get(token),
    hasTool: (name) => {
      try {
        deps.tools(name);
        return true;
      } catch (error) {
        if (error instanceof UnknownToolError) return false;
        throw error;
      }
    },
  };
  const { type } = bundle.graph;
  const workflow = { type, name: deps.config.name, version: deps.config.version };
  rememberAppWorkflow(app, { workflow, tenant: defaultTenantOf(contexts) });
  return {
    app,
    deps,
    bundle,
    refuse: () => {
      closed = true;
    },
    settled: () => live.settled(),
    interrupt: (reason) => {
      live.interrupt(reason);
    },
    recover: recoverRootOf({ deps, moves, current, policy }),
  };
}
