import { randomUUID } from "node:crypto";
import { rememberAppWorkflow } from "./app-workflow.js";
import type { Class } from "../components/injection.js";
import { workflowOf } from "../components/assemble.js";
import { environmentFor, workflowFileOf } from "../environments/load.js";
import { withProfile } from "../profile-workflow.js";
import { resumeAgent } from "../run/resume-agent.js";
import { checkThreadAccess, checkThreadOwner } from "../run/thread.js";
import { checkRunLimits } from "./limit-check.js";
import { runAgent } from "../run/run-agent.js";
import { runVersions } from "../run/versions.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AssembledWorkflow } from "../workflow.js";
import { createAppDeps, type AppDeps, type AppDepsOptions } from "./app-deps.js";
import {
  createMemoryPausedRunRepository,
  pausedRunBook,
  type PausedRunRepository,
} from "./paused-runs.js";
import { UnknownToolError } from "./parts.js";
import { cancelledOutcome, LiveRuns, runOptionsOf } from "./live-runs.js";
import { admitRequest, observeCancelledPause, observeLeg } from "./run-events.js";
import { checkedStart, textStartOf } from "./starts.js";
import { runResultOf } from "./result.js";
import type { App, ExecutionOutput } from "./types.js";
import type { RunOperation } from "../core/observability.js";
import { ApplicationStoppingError } from "./application-stopping.js";

export { NotAWorkflowStartError } from "./starts.js";

/** `createApp` options: a profile on top of the workflow, and any part instead of its default. */
export interface AppOptions extends AppDepsOptions {
  /**
   * The environment: `environments/<env>.environment.ts` next to the workflow file (default `dev`);
   * `environment` (values) wins over it.
   */
  readonly env?: string | undefined;
  /** `profiles/<workflow>/<profile>.yaml` under `profileRoot` (default: the working directory). */
  readonly profile?: string | undefined;
  readonly profileRoot?: string;
  /**
   * Where paused runs wait for `resume` (default: in memory, this app only). For runs that survive
   * a restart or a redeploy give `createSqlitePausedRunRepository()` plus a durable checkpointer.
   */
  readonly pausedRuns?: PausedRunRepository;
}

/** Why an execution or a resume is refused once `app.close()` has begun. */
const STOPPING = "the app is stopping: app.close() was called, no new execution is accepted";

/** An app with the parts it was built from (the testing toolkit's slices read them). */
export interface BuiltApp {
  readonly app: App;
  readonly deps: AppDeps;
  readonly bundle: AssembledWorkflow;
}

/** The app over already assembled parts (a profile applied, test replacements given). */
// eslint-disable-next-line max-lines-per-function
export async function buildApp(
  bundle: AssembledWorkflow,
  options: AppOptions = {},
): Promise<BuiltApp> {
  checkRunLimits(bundle.config.name, bundle.limits);
  const deps = await createAppDeps(bundle, options);
  const paused = pausedRunBook(
    options.pausedRuns ?? createMemoryPausedRunRepository(),
    { workflowVersion: deps.config.version, configHash: runVersions(deps).configHash },
    bundle.onIncompatibleResume,
  );
  const settle = async (run: AgentExecutionOutput, record = false): Promise<ExecutionOutput> => {
    await paused.settle(run);
    return runResultOf(run, record);
  };
  const live = new LiveRuns();
  const owned = (thread: string, owner: string | undefined) =>
    checkThreadOwner(deps.terns, deps.config.name, thread, owner);
  const known = (thread: string, owner: string | undefined) =>
    checkThreadAccess(deps.terns, deps.config.name, thread, owner);
  let closed = false;
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
      const result = await observeLeg(deps.observer, state, async () =>
        settle(
          await live.track(thread, call.signal, (signal) =>
            runAgent(given, deps, { ...runOptionsOf(call, signal), runId }),
          ),
          call.record === true,
        ),
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
        await deps.terns.complete(waiting.ternId, cancelledOutcome(waiting));
        await observeCancelledPause(deps.observer, { runId: waiting.runId, threadId: thread });
      }
      return { cancelled: running || waiting !== undefined };
    },
    resume: async (thread, decision, call = {}) => {
      const run = await admit("resume", thread, async () => {
        accepting();
        await owned(thread, call.owner);
        return paused.resumable(thread);
      });
      const state = { runId: run.runId, threadId: thread };
      await deps.observer.onWorkflowResume({ decision, state });
      return observeLeg(deps.observer, state, async () =>
        settle(
          await live.track(thread, call.signal, (signal) =>
            resumeAgent(run, decision, deps, runOptionsOf(call, signal)),
          ),
          call.record === true,
        ),
      );
    },
    close: async () => {
      if (closed) return;
      closed = true;
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
  return { app, deps, bundle };
}

/**
 * Builds a workflow into an app: the container, the graph (every assembly error at once), the
 * components' `onStart` hooks — `const app = await createApp(JobScout)`; then
 * `app.execute(ChatWorkflowStart, { text })`, `app.resume(thread, decision)`, `app.close()`.
 */
export async function createApp(workflow: Class, options: AppOptions = {}): Promise<App> {
  const bundle = await withProfile(
    await workflowOf(workflow),
    options.profile,
    options.profileRoot,
  );
  const environment = await environmentFor(
    workflowFileOf(workflow),
    options,
    options.processEnv ?? process.env,
  );
  return (await buildApp(bundle, { ...options, environment })).app;
}
