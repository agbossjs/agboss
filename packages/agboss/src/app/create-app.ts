import { randomUUID } from "node:crypto";
import { rememberAppWorkflow } from "./app-workflow.js";
import { checkThreadAccess, checkThreadOwner } from "../run/thread.js";
import { checkRunLimits } from "./limit-check.js";
import { runAgent } from "../run/run-agent.js";
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
import { DEFAULT_TENANT_ID } from "../infrastructure/tenant.js";
import { systemTimers } from "../infrastructure/timers.js";
import { admitRequest, observeCancelledPause } from "./run-events.js";
import { checkedStart, textStartOf } from "./starts.js";
import type { App, ExecutionOutput } from "./types.js";
import type { RunOperation } from "../core/observability.js";
import { ApplicationStoppingError } from "./application-stopping.js";
import { recoverRootOf, type RecoverRoot } from "./recover-root.js";

export { NotAWorkflowStartError } from "./starts.js";

/**
 * `createApp` options: the environment, a profile on top of each workflow, and any external part
 * (models, MCP transports) instead of its default. Infrastructure is not an option: it is listed in
 * `@Application({ providers })`.
 */
export interface AppOptions extends AppDepsOptions {
  /**
   * The environment: `environments/<env>.environment.ts` next to the application file (default
   * `dev`); `environment` (values) wins over it.
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
  checkRunLimits(bundle.config.name, bundle.limits);
  const deps = await createWorkflowDeps(bundle, options, parts);
  const current = {
    workflowVersion: deps.config.version,
    configHash: runVersions(deps).configHash,
  };
  const policy = bundle.onIncompatibleResume;
  const paused = pausedRunBook(parts.infrastructure.pausedExecutions, current, policy);
  const live = new LiveRuns();
  const { executionLeases, executionTrees: trees } = parts.infrastructure;
  const leases = executionLeasesOf(executionLeases, parts.timers ?? systemTimers);
  const moves = treeMovesOf({ deps, live, paused, leases, trees });
  const owned = (thread: string, owner: string | undefined) =>
    checkThreadOwner(deps.terns, deps.config.name, thread, owner);
  const known = (thread: string, owner: string | undefined) =>
    checkThreadAccess(deps.terns, deps.config.name, thread, owner);
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
    execute: async (start, input, call = {}) => {
      const checked = await admit("execute", call.thread, async () => {
        accepting();
        const valid = checkedStart(start, input, bundle.graph);
        if (call.thread !== undefined) await known(call.thread, call.owner);
        return valid;
      });
      // the thread is known before the run starts, so `cancel(thread)` reaches a new one too
      const thread = call.thread ?? (await deps.terns.createThread(deps.config.name, call.owner));
      // one id for the whole run: its observer events, `executionContext.executionId`, its Tern and its result
      const runId = deps.newRunId?.() ?? randomUUID();
      const state = { runId, threadId: thread };
      await deps.observer.onWorkflowStart(state);
      const given = { start: checked.name, input: checked.input, threadId: thread };
      const result = await moves.first(state, call, (moving, signal) =>
        runAgent(given, moving, { ...runOptionsOf(call, signal), runId }),
      );
      // the generated `WorkflowStarts` types the output; at run time it is the finish's validated DTO
      return result as ExecutionOutput<never>;
    },
    cancel: async (thread, options = {}) => {
      await admit("cancel", thread, () => owned(thread, options.owner));
      const running = live.abort(thread);
      const waiting = await paused.drop(thread);
      // a running resume completes its own Tern when the abort stops it
      if (waiting !== undefined && !running) {
        await trees.deleteAllInTree({
          tenantId: DEFAULT_TENANT_ID,
          rootExecutionId: waiting.runId,
        });
        await deps.terns.complete(waiting.ternId, cancelledOutcome(waiting));
        await observeCancelledPause(deps.observer, { runId: waiting.runId, threadId: thread });
      }
      return { cancelled: running || waiting !== undefined };
    },
    // two phases (Q58): the decision recorded (Pending → Resolved, atomic), then the tree moved
    resume: async (thread, decision, call = {}) => {
      const run = await admit("resume", thread, async () => {
        accepting();
        await owned(thread, call.owner);
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
  rememberAppWorkflow(app, { type, name: deps.config.name, version: deps.config.version });
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
