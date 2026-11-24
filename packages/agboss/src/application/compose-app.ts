import { keptAlive, pauseCallsOf } from "./kept-alive-app.js";
import { assemblyWarningsOf, logStart, warningText } from "./start-log.js";
import { stopOf, type InstanceParts } from "./graceful-stop.js";
import type { BuiltApplication } from "./create-app.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { appWorkflowOf, rememberAppWorkflow } from "../app/app-workflow.js";
import type { BuiltApp } from "../app/create-app.js";
import type { AnyTenantApp } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { AssembledApplication } from "./assemble.js";
import type { GracefulStop } from "./graceful-stop.js";
import { listedProviderCheckOf, rememberListedProviders } from "./listed-providers.js";
import type {
  ApplicationHealth,
  HealthSources,
  ProjectHealthCheck,
} from "../health/health-sources.js";
import { healthCheckOf, type HealthCheckHandler } from "../health/health-check.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionAuditLogRepository } from "../infrastructure/execution-audit-log.repository.js";
import type { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
import { instanceReadsOf, listPausesOf } from "./instance-reads.js";
import type { RecoverySweep } from "../infrastructure/recovery.js";
import type { PauseTimers } from "./pause-timers.js";
import { modelProvidersOf } from "../models/resolution.js";
import type { StepCapacity } from "../app/step-slots.js";
import { rememberMeshSettings } from "../mesh/mesh-settings.js";
import { meshSettingsFor } from "../mesh/mesh-start.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The app of an application instance (#261): `execute` runs the workflow its start belongs to (a
 * start is the door of one workflow), `resume` the workflow its pause waits in, `cancel` the
 * workflow of the thread; `close()` is
 * the instance's graceful stop (`graceful-stop.ts`); `checkLiveness()` / `checkReadiness()` its
 * probes (#300, loaded on first use).
 */

/** Each start class with the workflow it opens. */
function startsOf(workflows: readonly BuiltApp[]): ReadonlyMap<Class, BuiltApp> {
  const starts = new Map<Class, BuiltApp>();
  for (const workflow of workflows) {
    for (const node of workflow.bundle.graph.nodes.values()) {
      if (node.kind === NodeKind.Start) starts.set(node.component, workflow);
    }
  }
  return starts;
}

/** What an instance adds to its workflows' apps: its graceful stop, warnings and probes. */
export interface InstanceSurface extends Pick<
  Infrastructure,
  "pausedExecutions" | "executionHistory" | "records"
> {
  readonly stop: GracefulStop;
  /** `app.checkLiveness()` / `app.checkReadiness()` (#300). */
  readonly health: ApplicationHealth;
  /** The assembly warnings, then each workflow's (a config changed without a version bump). */
  readonly warnings: readonly string[];
  /** `app.auditLogOf` (#501): the instance's audit log. */
  readonly auditLog: ExecutionAuditLogRepository;
  /** `app.outboundCallsOf` / `app.pendingOutboundCallsOf` (#505): the instance's outbound calls. */
  readonly outboundCalls: OutboundCallRepository;
}

/** `cancel` and `stop`: each routed to the workflow its thread belongs to. */
const threadCallsOf = (
  ofThread: (thread: string, tenantId?: string) => Promise<BuiltApp>,
): Pick<AnyTenantApp, "cancel" | "stop"> => ({
  cancel: async (threadId, options) =>
    (await ofThread(threadId, options?.tenantId)).app.cancel(threadId, options),
  stop: async (threadId, options) =>
    (await ofThread(threadId, options?.tenantId)).app.stop(threadId, options),
});

export function composeApp(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  surface: InstanceSurface,
  processEnv: NodeJS.ProcessEnv = process.env,
): AnyTenantApp {
  const { stop, warnings } = surface;
  const [first] = workflows;
  // the assembly rejects an application without workflows
  if (first === undefined) throw new Error(`${assembled.name} has no workflows`);
  const starts = startsOf(workflows);
  /** The workflow a tenant's thread belongs to; an unknown thread goes to the first, which rejects it. */
  const ofThread = async (thread: string, tenantId = DEFAULT_TENANT_ID): Promise<BuiltApp> => {
    for (const workflow of workflows) {
      const { turns, config } = workflow.deps;
      if (await turns.hasThread(config.name, tenantId, thread)) return workflow;
    }
    return first;
  };
  /** The workflow a tenant's pause waits in (a child's: its root's); an unknown one goes to the first. */
  const ofPause = async (pauseId: string, tenantId = DEFAULT_TENANT_ID): Promise<BuiltApp> => {
    const pause = await first.deps.pause?.pauses.findByTenantIdAndPauseId(tenantId, pauseId);
    // a pause inside a child workflow (#263) is resumed by its root's workflow: the thread's
    if (pause !== undefined && pause.executionId !== pause.rootExecutionId)
      return ofThread(pause.threadId, tenantId);
    const named = workflows.find((workflow) => workflow.deps.config.name === pause?.workflow);
    return named ?? first;
  };
  const app: AnyTenantApp = keptAlive(assembled.hasTenantContext, {
    name: assembled.name,
    version: assembled.version,
    warnings,
    models: [...new Set(workflows.flatMap((workflow) => workflow.app.models))],
    // the start a plain text goes to: the first listed workflow's that has one
    textStart: workflows.map((one) => one.app.textStart).find((start) => start !== undefined),
    // a start no workflow has goes to the first, whose check rejects it (`onRunRejected`)
    execute: async (start, input, ...options) =>
      (starts.get(start) ?? first).app.execute(start, input, ...options),
    resume: async (request, options) =>
      (await ofPause(request.pauseId, options?.tenantId)).app.resume(request, options),
    ...pauseCallsOf(ofPause),
    ...threadCallsOf(ofThread),
    close: async (options) => stop.close(options),
    ...instanceReadsOf(surface),
    listPauses: async (query) => listPausesOf(workflows, ofThread, surface.pausedExecutions)(query),
    resolve: (token) => first.app.resolve(token),
    hasTool: (name) => workflows.some((workflow) => workflow.app.hasTool(name)),
  });
  const remembered = appWorkflowOf(first.app);
  if (remembered !== undefined) rememberAppWorkflow(app, remembered);
  rememberListedProviders(app, listedProviderCheckOf(assembled.modules));
  // the instance's one observer manager: every workflow's is it (#875, #860)
  const mesh = meshSettingsFor(assembled, app, processEnv);
  rememberMeshSettings(app, () => mesh);
  return app;
}

/**
 * The probes of an instance, loaded on first use (QUALITY.md → Design: a runtime subsystem loads
 * lazily) — the root import keeps only the decorator, the result builders and the enums.
 */
function lazyApplicationHealth(sources: HealthSources): ApplicationHealth {
  let loaded: Promise<ApplicationHealth> | undefined;
  const health = (): Promise<ApplicationHealth> =>
    (loaded ??= lazyLoad(import("../health/application-health.js")).then((module) =>
      module.applicationHealthOf(sources),
    ));
  return {
    checkLiveness: async () => (await health()).checkLiveness(),
    checkReadiness: async () => (await health()).checkReadiness(),
  };
}

/**
 * The probes of one application instance (#300): what `app.checkLiveness()` and
 * `app.checkReadiness()` read — its stop, its recovery sweep, its stores and clock, its model
 * providers and the project's `@HealthCheck`s, created by its container at start.
 */

/** What an instance's probes are made of besides the application. */
export interface InstanceHealthParts {
  readonly stop: GracefulStop;
  readonly sweep: RecoverySweep;
  readonly timers: PauseTimers;
  readonly infrastructure: Infrastructure;
  /** The instance's step slots (#332): readiness reports them when the application caps them. */
  readonly stepSlots?: StepCapacity | undefined;
}

/** The project's checks, each with its instance (created at start: its dependencies fail there). */
function projectChecksOf(
  checks: readonly Class[],
  workflows: readonly BuiltApp[],
): readonly ProjectHealthCheck[] {
  const [first] = workflows;
  if (first === undefined) return [];
  return checks.flatMap((cls) => {
    const meta = healthCheckOf(cls);
    // `@HealthCheck` types the class as a `HealthCheckHandler` (its decorator's constraint)
    return meta === undefined
      ? []
      : [{ meta, handler: first.app.resolve(cls) as HealthCheckHandler }];
  });
}

export function instanceHealthOf(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  parts: InstanceHealthParts,
): ApplicationHealth {
  return lazyApplicationHealth({
    application: assembled.name,
    isStopping: () => parts.stop.isStopping(),
    sweep: parts.sweep,
    timers: parts.timers,
    infrastructure: parts.infrastructure,
    modelProviders: modelProvidersOf(assembled.providers),
    healthChecks: projectChecksOf(assembled.healthChecks, workflows),
    storage: assembled.storage,
    stepSlots: parts.stepSlots,
  });
}

/**
 * An application instance once its workflows are built and started (#261): its recovery sweep and
 * graceful stop, its start logged with its warnings, its probes and its app.
 */

/** What an instance's app is made of once its workflows are built. */
export interface InstanceAppParts extends InstanceParts {
  readonly contexts: RuntimeContexts;
  readonly quiet: boolean | undefined;
  /** The process environment the instance reads its references from (the mesh's keys). */
  readonly processEnv: NodeJS.ProcessEnv;
}

/** The instance's stop and sweep started, its start logged, its app composed. */
export function instanceAppOf(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  parts: InstanceAppParts,
): Pick<BuiltApplication, "app" | "infrastructure" | "closed" | "log"> {
  const { infrastructure, log } = parts;
  const { stop, sweep, timers } = stopOf(assembled, workflows, parts);
  const warnings = startupWarningsOf(assembled, workflows);
  if (parts.quiet !== true)
    logStart(log, parts.contexts.application, assembled.workflows, warnings);
  const health = instanceHealthOf(assembled, workflows, { stop, sweep, timers, ...parts });
  const surface = { stop, warnings, health, ...infrastructure };
  const app = composeApp(assembled, workflows, surface, parts.processEnv);
  return { app, infrastructure, closed: stop.closed, log };
}

/**
 * The assembly warnings, then each workflow's own (a config changed without a version bump).
 */
const startupWarningsOf = (
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
): readonly string[] => [
  ...assemblyWarningsOf(assembled).map(warningText),
  ...workflows.flatMap((workflow) => workflow.app.warnings),
];
