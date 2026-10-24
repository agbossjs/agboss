import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { AppDepsOptions, BuildOptions, WorkflowDepsParts } from "../app/app-deps.js";
import { buildApp, type AppOptions, type BuiltApp } from "../app/create-app.js";
import type { App } from "../app/types.js";
import type { ContainerOptions } from "../components/container/container.js";
import { startComponents } from "../components/container/lifecycle.js";
import type { Class } from "../components/injection.js";
import {
  APP_DEFAULT_ENVIRONMENT,
  namedEnvironmentFor,
  type EnvironmentOwner,
} from "../environments/load.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import { randomUUID } from "node:crypto";
import { applicationContextOf } from "../flow/context/application-context.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Clock, IdGenerator } from "../infrastructure/clock.js";
import type { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import { applicationContainerOf, clockOf, resolveInfrastructure } from "./application-container.js";
import { composeApp, instanceHealthOf } from "./compose-app.js";
import { stopOf } from "./graceful-stop.js";
import { closeOnStopSignals } from "./stop-signals.js";
import { applicationOf, type AssembledApplication } from "./assemble.js";
import { frameworkLogOf, type FrameworkLog } from "../infrastructure/logger.js";
import { observerManagerOf } from "./observers.js";
import { assemblyWarningsOf, logStart, warningText } from "./start-log.js";
import type { ApplicationClass } from "./types.js";
import { applicationPiiKeyOf, applicationPiiMaskOf } from "./application-pii.js";
import type { GraphDeps } from "../graph/deps.js";
import type * as InstanceSteps from "./instance-steps.js";
import { childrenFirst } from "../flow/analyse/child-workflow.js";

/** An application instance with the parts it was built from (the testing toolkit reads them). */
export interface BuiltApplication {
  readonly app: App;
  readonly assembled: AssembledApplication;
  readonly workflows: readonly BuiltApp[];
  readonly infrastructure: Infrastructure;
  /** Resolves when `app.close()` has finished. */
  readonly closed: Promise<void>;
  /** The instance's log (its `Logger`, stamped by its clock). */
  readonly log: FrameworkLog;
}

/**
 * What a test gives an application instance beyond `createApp`'s options (never in production):
 * the instances an earlier app of the test created (its stores: a paused execution survives
 * `recoverApp()`), this instance's id, the in-memory rows its instances share, its ids (#313: unless
 * the application lists an `IdGenerator`) and its `VirtualClock` — always, whatever `Clock` the
 * application lists: tests never run on real time. In production the listed ones, else built-in.
 */
export interface InstanceSeams {
  readonly reused?: ReadonlyMap<Class, unknown>;
  readonly instanceId?: string;
  readonly database?: InMemoryDatabase;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  /** A test's instance: an unlisted `Logger` is silent, and the start is not logged. */
  readonly quiet?: boolean;
  /**
   * The PII key when the application sets none (`testWith`: a fixed one shared by its instances,
   * #334); absent = a key of the instance, one per root execution — what production does.
   */
  readonly piiTestKey?: string;
  /** Observers of the instance besides the application's (a test's call recorder, #262). */
  readonly observers?: readonly ExecutionObserver[];
}

/**
 * The instance's context levels (#261): its one `ApplicationContext` — name, version, its id,
 * when it started (the framework's clock), the chosen environment and the host — and the context
 * classes the application declares.
 */
export function contextsOf(
  assembled: AssembledApplication,
  options: AppDepsOptions,
  seams: InstanceSeams,
  clock: Clock,
): RuntimeContexts {
  const application = applicationContextOf({
    name: assembled.name,
    version: assembled.version,
    instanceId: seams.instanceId ?? randomUUID(),
    startedAt: clock.now(),
    environmentName: options.environmentName ?? APP_DEFAULT_ENVIRONMENT,
    environment: options.environment ?? NO_ENVIRONMENT_VALUES,
  });
  const { tenantContext, executionContext } = assembled;
  return { application, tenantContext, executionContext };
}

/**
 * Every class the application and its workflows list (providers, budgets), created now — one
 * instance each, so a missing dependency fails at start and every one gets its hooks.
 */
function createListed(assembled: AssembledApplication, workflows: readonly BuiltApp[]): void {
  const [first] = workflows;
  if (first === undefined) return;
  for (const module of assembled.modules) {
    for (const provider of module.providers) {
      if (!("provide" in provider)) first.app.resolve(provider);
    }
  }
}

/**
 * Builds every workflow of the application into `built`: every child before its parents (#336: a
 * parent's `configHash` covers its children's deps, read at its build), then `built` in the
 * application's order; a parent compiles its children's graphs from their deps, looked up by class
 * when it runs (#263).
 */
async function buildWorkflows(
  assembled: AssembledApplication,
  options: BuildOptions,
  parts: Omit<WorkflowDepsParts, "childDepsOf">,
  built: BuiltApp[],
): Promise<void> {
  const byClass = new Map<Class, GraphDeps<string>>();
  const childDepsOf = (workflow: Class): GraphDeps<string> | undefined => byClass.get(workflow);
  const bundles = new Map(assembled.workflows.map((bundle) => [bundle.graph.type, bundle]));
  for (const type of childrenFirst([...bundles.keys()])) {
    const bundle = bundles.get(type);
    if (bundle === undefined) continue;
    const history = historyOf(assembled, parts.infrastructure);
    const workflow = await buildApp(bundle, options, { ...parts, ...history, childDepsOf });
    byClass.set(type, workflow.deps);
    built.push(workflow);
  }
  const order = [...bundles.keys()];
  built.sort(
    (left, right) => order.indexOf(left.bundle.graph.type) - order.indexOf(right.bundle.graph.type),
  );
}

/** The instance's step slots and running step bodies (#332, #367), loaded with the instance. */
const instancePartsOf = async (
  ...args: Parameters<typeof InstanceSteps.instancePartsOf>
): Promise<InstanceSteps.SharedInstanceParts> =>
  (await import("./instance-steps.js")).instancePartsOf(...args);

/** Closes what the workflows already built opened (a later workflow or a start hook failed). */
async function releaseAll(built: readonly BuiltApp[]): Promise<void> {
  for (const workflow of built) await workflow.app.close();
}

/**
 * Builds an assembled application into one instance: one container for the application (its
 * infrastructure first, then every workflow's components), then `onInit` → `onStart` of every
 * component the container created — once, for all the workflows.
 */
export async function buildApplication(
  assembled: AssembledApplication,
  options: BuildOptions = {},
  seams: InstanceSeams = {},
): Promise<BuiltApplication> {
  const created: unknown[] = [];
  const onCreate = (instance: unknown): void => {
    created.push(instance);
    options.container?.onCreate?.(instance);
  };
  // the clock first: the contexts read their start from it
  const clock = seams.clock ?? clockOf(assembled.modules, { ...options.container, onCreate });
  const contexts = contextsOf(assembled, options, seams, clock);
  const sources = { modules: assembled.modules, clock, contexts, idGenerator: seams.idGenerator };
  const { database, reused: instances, quiet } = seams;
  const shared = applicationContainerOf(
    { ...sources, database, instances, quiet },
    { ...options.container, onCreate },
  );
  const container: ContainerOptions = { ...options.container, application: shared };
  const infrastructure = resolveInfrastructure(shared, { ...container, onCreate });
  const processEnv = options.processEnv ?? process.env;
  const environment = options.environment ?? NO_ENVIRONMENT_VALUES;
  // a test's instances share a fixed PII key when the application sets none (#120, #334)
  const fallback = seams.piiTestKey;
  const piiKey = applicationPiiKeyOf(assembled, { environment, env: processEnv, fallback });
  const piiParts = { processEnv, fieldKey: piiKey.key, contexts };
  const mask = applicationPiiMaskOf(assembled, shared, { ...container, onCreate }, piiParts);
  const log = frameworkLogOf(infrastructure.logger, clock, (message) => mask.text(message));
  const { executionTrees, childQueue } = infrastructure;
  const instance = await instancePartsOf(assembled, clock, log, executionTrees, childQueue);
  const workflows: BuiltApp[] = [];
  try {
    const observer = observerManagerOf(assembled, shared, { ...container, onCreate }, log, seams);
    const budgets = { budgets: assembled.budgets, applicationName: assembled.name };
    const parts = { infrastructure, created, contexts, budgets, observer, piiKey, ...instance };
    await buildWorkflows(assembled, { ...options, container }, parts, workflows);
    createListed(assembled, workflows);
    await startComponents(created);
  } catch (error) {
    await releaseAll(workflows);
    throw error;
  }
  const stopParts = { created, infrastructure, log, ...instance };
  const { stop, sweep } = stopOf(assembled, workflows, stopParts);
  const warnings = startupWarningsOf(assembled, workflows, piiKey.isInstanceKey);
  if (seams.quiet !== true) logStart(log, contexts.application, assembled.workflows, warnings);
  const probed = { stop, sweep, infrastructure, ...instance };
  const health = instanceHealthOf(assembled, workflows, probed);
  const app = composeApp(assembled, workflows, { stop, warnings, health });
  return { app, assembled, workflows, infrastructure, closed: stop.closed, log };
}

/** The store of the root executions' history, when the application keeps it (#401). */
const historyOf = (assembled: AssembledApplication, infrastructure: Infrastructure) =>
  assembled.executionRecordRetention === undefined
    ? {}
    : { executionHistory: infrastructure.executionHistory };

/**
 * The assembly warnings (a PII key of the instance only when it made one, S94 — never under
 * `testWith`, which has a fixed key), then each workflow's own (a config changed without a version
 * bump).
 */
const startupWarningsOf = (
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  isInstanceKey: boolean,
): readonly string[] => [
  ...assemblyWarningsOf({ ...assembled, isPiiKeyOfInstance: isInstanceKey }).map(warningText),
  ...workflows.flatMap((workflow) => workflow.app.warnings),
];

/** Where an assembled application's environments are, and its contract. */
export const environmentOwnerOf = (assembled: AssembledApplication): EnvironmentOwner => ({
  application: assembled.name,
  source: assembled.source,
  contract: assembled.environment,
});

/**
 * Builds an `@Application` into an app instance: every workflow assembled (all assembly errors at
 * once), the environment next to the application file, one container, the components' `onInit` →
 * `onStart` — `const app = await createApp(JobScoutApplication, { env: "prod" })`; then
 * `app.execute(ScreeningWorkflowStart, input)` runs the workflow of that start,
 * `app.resume({ pauseId, decision })`, `app.close()` — also on SIGTERM / SIGINT (#265 S51).
 */
export async function createApp<TApplication extends Class>(
  application: ApplicationClass<TApplication>,
  options: AppOptions = {},
): Promise<App> {
  return (await builtApplicationOf(application, options)).app;
}

/**
 * `createApp` with the parts the instance was built from (internal: `agboss eval run`, #396 PR 2,
 * runs suites on them) — the same assembly, environment, container and stop signals; `chaos`
 * (#396 PR 6) injects failures into its model calls, an option of this internal path only.
 */
export async function builtApplicationOf(
  application: Class,
  options: AppOptions & Pick<BuildOptions, "chaos"> = {},
): Promise<BuiltApplication> {
  const assembled = await applicationOf(application, options);
  const environment = await namedEnvironmentFor(
    environmentOwnerOf(assembled),
    options,
    options.processEnv ?? process.env,
  );
  const built = await buildApplication(assembled, { ...options, ...environment });
  closeOnStopSignals(built);
  return built;
}
