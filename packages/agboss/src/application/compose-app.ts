import { appWorkflowOf, rememberAppWorkflow } from "../app/app-workflow.js";
import type { BuiltApp } from "../app/create-app.js";
import type { App } from "../app/types.js";
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
import type { RecoverySweep } from "../infrastructure/recovery.js";
import { modelProvidersOf } from "../models/resolution.js";
import type { StepCapacity } from "../app/step-slots.js";
import { rememberMeshSettings } from "../mesh/mesh-settings.js";
import { meshSettingsFor } from "../mesh/mesh-start.js";

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

/** The start a plain text goes to: the first listed workflow's that has one. */
const textStartOf = (workflows: readonly BuiltApp[]): Class | undefined =>
  workflows.map((workflow) => workflow.app.textStart).find((start) => start !== undefined);

/** What an instance adds to its workflows' apps: its graceful stop, warnings and probes. */
export interface InstanceSurface {
  readonly stop: GracefulStop;
  /** `app.checkLiveness()` / `app.checkReadiness()` (#300). */
  readonly health: ApplicationHealth;
  /** The assembly warnings, then each workflow's (a config changed without a version bump). */
  readonly warnings: readonly string[];
}

export function composeApp(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  { stop, warnings, health }: InstanceSurface,
): App {
  const [first] = workflows;
  // the assembly rejects an application without workflows
  if (first === undefined) throw new Error(`${assembled.name} has no workflows`);
  const starts = startsOf(workflows);
  /** The workflow a tenant's thread belongs to; an unknown thread goes to the first, which rejects it. */
  const ofThread = async (thread: string, tenantId = DEFAULT_TENANT_ID): Promise<BuiltApp> => {
    for (const workflow of workflows) {
      const { terns, config } = workflow.deps;
      if (await terns.hasThread(config.name, tenantId, thread)) return workflow;
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
  const app: App = {
    name: assembled.name,
    version: assembled.version,
    warnings,
    models: [...new Set(workflows.flatMap((workflow) => workflow.app.models))],
    textStart: textStartOf(workflows),
    // a start no workflow has goes to the first, whose check rejects it (`onRunRejected`)
    execute: (start, input, ...options) =>
      (starts.get(start) ?? first).app.execute(start, input, ...options),
    resume: async (request, options) =>
      (await ofPause(request.pauseId, options?.tenantId)).app.resume(request, options),
    cancel: async (threadId, options) =>
      (await ofThread(threadId, options?.tenantId)).app.cancel(threadId, options),
    close: (options) => stop.close(options),
    checkLiveness: () => health.checkLiveness(),
    checkReadiness: () => health.checkReadiness(),
    resolve: (token) => first.app.resolve(token),
    hasTool: (name) => workflows.some((workflow) => workflow.app.hasTool(name)),
  };
  const remembered = appWorkflowOf(first.app);
  if (remembered !== undefined) rememberAppWorkflow(app, remembered);
  rememberListedProviders(app, listedProviderCheckOf(assembled.modules));
  const mesh = meshSettingsFor(assembled, app);
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
    (loaded ??= import("../health/application-health.js").then((module) =>
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
    infrastructure: parts.infrastructure,
    modelProviders: modelProvidersOf(assembled.providers),
    healthChecks: projectChecksOf(assembled.healthChecks, workflows),
    stepSlots: parts.stepSlots,
  });
}
