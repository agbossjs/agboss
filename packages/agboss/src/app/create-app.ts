import type { MeterProvider } from "@opentelemetry/api";
import { lazyLoad } from "../infrastructure/clock.js";
import { runIdOf, treeControlOf, type TreeControl } from "./tree-control.js";
import { newThreadOf } from "./new-thread.js";
import { rememberAppWorkflow } from "./app-workflow.js";
import { workflowIdentityOf } from "../flow/runtime/workflow-keys.js";
import {
  checkThreadAccess,
  checkThreadOwner,
  isNewThread,
  type ThreadAccess,
} from "../run/thread.js";
import { runOpenedAgent } from "../run/run-agent.js";
import { openExecutionBudgets } from "../run/run-budgets.js";
import { executionVersions } from "../run/versions.js";
import type { AssembledWorkflow } from "../workflow.js";
import {
  createWorkflowDeps,
  type AppDeps,
  type BuildOptions,
  type WorkflowDepsParts,
} from "./app-deps.js";
import { pausedRunBook } from "./paused-runs.js";
import { UnknownToolError, withWithdrawals } from "./parts.js";
import { LiveRuns, runOptionsOf } from "./live-runs.js";
import { executionLeasesOf } from "./execution-leases.js";
import { leasingOf } from "../infrastructure/contracts.js";
import { treeMovesOf } from "./tree-moves.js";
import {
  contextValuesOf,
  defaultTenantOf,
  contextsOutsideExecution,
} from "../flow/context/runtime-contexts.js";
import { admitRequest, executionEventAt, type ExecutionRequest } from "./run-events.js";
import { checkedStart, textStartOf } from "./starts.js";
import type { ExecutionOptions, ExecutionOutput, WorkflowApp } from "./types.js";
import { ExecutionOperation } from "../core/observability.js";
import { ApplicationStoppingError } from "../core/errors.js";
import { closeOrphanTreeOf, type CloseOrphanTree } from "./orphan-tree.js";
import { recoverRootOf, type RecoverRoot } from "./recover-root.js";
import { treeToolsOf, treeQuestionAnswersOf } from "./child-deps.js";
import { lazyReplyAnswering, resumeOf } from "./resume.js";
import { meshContextValuesOf } from "../mesh/mesh-context-values.js";
import { checkedCallerId } from "../flow/context/context-values.js";

export { NotAWorkflowStartError } from "./starts.js";

/**
 * `createApp` options (#834): the environment, a profile on top of each workflow and where the
 * instance publishes its metrics — nothing else. Infrastructure is listed in
 * `@Application({ providers })`; every other setting is an `@Application` option, and the seams a
 * test or a tool replaces (models, MCP transports, the process environment) are on the internal
 * build path only (`testWith`, the CLI).
 */
export interface AppOptions {
  /**
   * The environment: `environments/<env>.environment.ts` next to the application file (default
   * `dev`) — of an application that declares `@Application({ environment })`.
   */
  readonly env?: string | undefined;
  /** `profiles/<workflow>/<profile>.yaml` under `profileRoot` (default: the working directory). */
  readonly profile?: string | undefined;
  readonly profileRoot?: string | undefined;
  /**
   * Where the instance publishes its metrics (#485, Wiki → Metrics): an OpenTelemetry
   * `MeterProvider` — an SDK one with a Prometheus or an OTLP exporter, or the global one
   * (`metrics.getMeterProvider()`). A runtime object, so an option here and not of `@Application`.
   * Absent = no metrics: nothing loaded, no store read.
   */
  readonly meterProvider?: MeterProvider;
}

/** Why an execution or a resume is refused once `app.close()` has begun. */
const STOPPING = "the app is stopping: app.close() was called, no new execution is accepted";

/**
 * One workflow of an application instance, built, with the parts it was built from (the testing
 * toolkit's slices read them): `refuse(deadline)` stops it taking new executions — its leases then
 * wait for their trees' running step bodies until `deadline` (#367) —, `settled()` waits for
 * the running ones, `interrupt(reason)` stops what still runs (the application's graceful stop),
 * `recover` continues one of its interrupted roots (the recovery sweep, #265 S30).
 */
export interface BuiltApp extends TreeControl {
  readonly app: WorkflowApp;
  readonly deps: AppDeps;
  readonly bundle: AssembledWorkflow;
  readonly refuse: (deadline: AbortSignal) => void;
  readonly settled: () => Promise<void>;
  readonly interrupt: (reason: ApplicationStoppingError) => void;
  readonly recover: RecoverRoot;
  /** Finishes the end of one of its trees an instance died in (the orphan look, #939). */
  readonly closeOrphan: CloseOrphanTree;
}

/** One workflow of an application over already assembled parts (a profile applied). */
// eslint-disable-next-line max-lines-per-function
export async function buildApp(
  bundle: AssembledWorkflow,
  options: BuildOptions,
  parts: WorkflowDepsParts,
): Promise<BuiltApp> {
  const { deps, withdrawn } = withWithdrawals(await createWorkflowDeps(bundle, options, parts));
  const current = {
    workflowVersion: deps.config.version,
    configHash: executionVersions(deps).configHash,
  };
  const policy = bundle.onIncompatibleResume;
  const { pausedExecutions: pauses, records: log } = parts.infrastructure;
  const { executionTrees: trees, clock, auditLog } = parts.infrastructure;
  // a cancel tells the channels of its sent pauses (#337)
  const paused = pausedRunBook({ pauses, answers: log, withdrawn }, deps, current, clock);
  const live = new LiveRuns();
  const leasing = leasingOf(parts.infrastructure);
  const leases = executionLeasesOf(leasing.repository, leasing.clock, {
    events: parts.auditLog,
    stopping: live.interruption,
  });
  const moves = treeMovesOf({ deps, live, paused, leases, trees, clock, auditLog });
  const owned = (access: ThreadAccess) => checkThreadOwner(deps.turns, deps.config.name, access);
  const known = (access: ThreadAccess) => checkThreadAccess(deps.turns, deps.config.name, access);
  const fresh = (access: ThreadAccess) => isNewThread(deps.turns, deps.config.name, access);
  // a pause inside a child (#263) is validated against the child's tool
  const questions = treeQuestionAnswersOf(deps);
  const tools = treeToolsOf(deps);
  const marks = { turns: deps.turns, log: deps.log };
  const answers = { pauses, paused, owned, tools, questions, current, policy, ...marks };
  const replies = { replies: lazyReplyAnswering(deps), clock, answers: log };
  const ownerOf = async (tenantId: string, threadId: string): Promise<string | undefined> =>
    (await deps.turns.threadOwner(deps.config.name, tenantId, threadId))?.owner;
  const newThread = newThreadOf(deps, owned);
  const contexts = deps.contexts ?? contextsOutsideExecution(deps.config);
  let closed = false;
  let released = false;
  const admit = <T>(request: ExecutionRequest, checks: () => Promise<T>) =>
    admitRequest(deps.observer, deps, request, checks);
  const cancelParts = { deps, live, paused, trees, clock, leases, admit, known };
  // its trees by id and the ids transports reserve (#807)
  const byId = treeControlOf(parts.infrastructure, cancelParts);
  /** From `app.close()` on (`onStop`), no new execution is accepted; running ones go on (#261). */
  const accepting = (): void => {
    if (closed) throw new ApplicationStoppingError({ message: STOPPING });
  };
  const app: WorkflowApp = {
    name: deps.config.name,
    version: deps.config.version,
    warnings: deps.warnings,
    models: deps.models,
    textStart: textStartOf(bundle.graph),
    execute: async (start, input, ...[given]) => {
      const call: ExecutionOptions = given ?? {};
      const named = call.tenant?.tenantId;
      const requested = {
        operation: ExecutionOperation.Execute,
        threadId: call.threadId,
        // the tenant the request named (unchecked: a rejection names it only when it is a string)
        tenantId: typeof named === "string" ? named : undefined,
      };
      const checked = await admit(requested, async () => {
        accepting();
        // #589: the owner is stored with the thread — a key's text, before anything is read
        checkedCallerId("ExecutionOptions", "ownerId", call.ownerId);
        const valid = checkedStart(start, input, bundle.graph);
        // the contexts' values, checked before the first step and frozen (#261); the call chain
        // a mesh transport admitted, kept with them (#398)
        const values = meshContextValuesOf(contextValuesOf(contexts, call), call, clock.now());
        const { tenantId } = values.tenant;
        const thread = { tenantId, threadId: call.threadId ?? "", ownerId: call.ownerId };
        // a given id the tenant does not have yet is the caller's own new thread (#262 Q4)
        const isNew = call.threadId === undefined || (await fresh(thread));
        return { ...valid, contexts: values, isNew };
      });
      const { tenantId } = checked.contexts.tenant;
      // one id for the whole run: its observer events, `executionContext.executionId`, its Turn and
      // its result — kept before anything of it is written, never another tree's (#591); a
      // transport's reserved id (#807: an A2A task's) is kept instead of a minted one
      const runId = await runIdOf(call, tenantId, deps.executionIds, byId.reservedIds);
      const { contexts: values } = checked;
      // before the first step (#261): each budget's `maxSpend()` once; one exhausted rejects it —
      // before anything is written: no thread, no record, no checkpoint
      const budgets = await admit({ ...requested, tenantId }, () =>
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
      const threadId = checked.isNew
        ? await newThread({ tenantId, threadId: call.threadId, ownerId: call.ownerId })
        : (call.threadId ?? "");
      const origin = values.mesh?.trusted?.origin;
      const tree = { runId, threadId, tenantId, startedVersion: deps.config.version, origin };
      await deps.observer.onExecutionStart(executionEventAt(tree, deps));
      const begun = { start: checked.name, input: checked.input, threadId };
      const result = await moves.first(tree, call, (moving, signal) =>
        runOpenedAgent(
          begun,
          moving,
          { ...runOptionsOf(call, signal), executionId: runId, contexts: values },
          budgets,
        ),
      );
      // the generated `WorkflowStarts` types the output; at run time it is the finish's validated DTO
      return result as ExecutionOutput<never>;
    },
    // loaded on the first cancel; one on another instance's execution leaves it a request (#360)
    cancel: async (threadId, options = {}) =>
      (await lazyLoad(import("./cancel-thread.js"))).cancelThread(cancelParts, threadId, options),
    resume: resumeOf({ ...answers, ...replies, admit, accepting, moves, ownerOf }),
    close: async () => {
      closed = true;
      if (released) return;
      released = true;
      await deps.close(() => live.settledByStop());
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
  const workflow = workflowIdentityOf(deps);
  rememberAppWorkflow(app, { workflow, tenant: defaultTenantOf(contexts) });
  return {
    app,
    deps,
    bundle,
    refuse: (deadline) => {
      closed = true;
      live.stopBy(deadline);
    },
    settled: () => live.settled(),
    interrupt: (reason) => {
      live.interrupt(reason);
    },
    recover: recoverRootOf({ deps, moves, current, policy }),
    closeOrphan: closeOrphanTreeOf({ deps, trees, clock, leases }),
    ...byId,
  };
}
