import type { AppDepsOptions } from "../app/app-deps.js";
import { buildApp, type AppOptions, type BuiltApp } from "../app/create-app.js";
import type { App } from "../app/types.js";
import type { ContainerOptions } from "../components/container/container.js";
import { startComponents } from "../components/container/lifecycle.js";
import type { Class } from "../components/injection.js";
import { environmentFor, type EnvironmentOwner } from "../environments/load.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import type { Timers } from "../infrastructure/timers.js";
import { applicationContainerOf, resolveInfrastructure } from "./application-container.js";
import { composeApp } from "./compose-app.js";
import { gracefulStopOf, type GracefulStop } from "./graceful-stop.js";
import { startRecoverySweep } from "../infrastructure/recovery.js";
import { closeOnStopSignals } from "./stop-signals.js";
import { systemTimers } from "../infrastructure/timers.js";
import { applicationOf, type AssembledApplication } from "./assemble.js";
import type { ApplicationClass } from "./types.js";

/** An application instance with the parts it was built from (the testing toolkit reads them). */
export interface BuiltApplication {
  readonly app: App;
  readonly assembled: AssembledApplication;
  readonly workflows: readonly BuiltApp[];
  readonly infrastructure: Infrastructure;
  /** Resolves when `app.close()` has finished. */
  readonly closed: Promise<void>;
}

/**
 * What a test gives an application instance beyond `createApp`'s options (never given in
 * production): the instances an earlier app of the same test created (its stores, so a paused
 * execution survives `recoverApp()`), this instance's id, the in-memory rows the instances of the
 * test share, and the virtual clock's timers.
 */
export interface InstanceSeams {
  readonly reused?: ReadonlyMap<Class, unknown>;
  readonly instanceId?: string;
  readonly database?: InMemoryDatabase;
  readonly timers?: Timers;
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
  options: AppDepsOptions = {},
  seams: InstanceSeams = {},
): Promise<BuiltApplication> {
  const created: unknown[] = [];
  const shared = applicationContainerOf({
    modules: assembled.modules,
    clock: options.clock,
    newThreadId: options.newThreadId,
    instanceId: seams.instanceId,
    database: seams.database,
    instances: seams.reused,
  });
  const container: ContainerOptions = { ...options.container, application: shared };
  const infrastructure = resolveInfrastructure(shared, {
    ...container,
    onCreate: (instance) => {
      created.push(instance);
      options.container?.onCreate?.(instance);
    },
  });
  const workflows: BuiltApp[] = [];
  try {
    for (const bundle of assembled.workflows) {
      workflows.push(
        await buildApp(
          bundle,
          { ...options, container },
          {
            infrastructure,
            created,
            ...(seams.timers === undefined ? {} : { timers: seams.timers }),
          },
        ),
      );
    }
    createListed(assembled, workflows);
    await startComponents(created);
  } catch (error) {
    await releaseAll(workflows);
    throw error;
  }
  const stop = stopOf(assembled, workflows, { created, infrastructure, timers: seams.timers });
  const app = composeApp(assembled, workflows, stop);
  return { app, assembled, workflows, infrastructure, closed: stop.closed };
}

/** What the instance's stop and recovery work with besides its workflows. */
interface InstanceParts {
  readonly created: readonly unknown[];
  readonly infrastructure: Infrastructure;
  readonly timers: Timers | undefined;
}

/** The instance's recovery sweep, started now (`onStart` is done, #265 S30), and its graceful stop. */
function stopOf(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  parts: InstanceParts,
): GracefulStop {
  const timers = parts.timers ?? systemTimers;
  const interruption = new AbortController();
  const sweep = startRecoverySweep({
    records: parts.infrastructure.records,
    workflows: new Map(workflows.map((workflow) => [workflow.deps.config.name, workflow.recover])),
    timers,
    signal: interruption.signal,
  });
  const { shutdownTimeout } = assembled;
  return gracefulStopOf({
    workflows,
    created: parts.created,
    sweep,
    timers,
    interruption,
    shutdownTimeout,
  });
}

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
 * `app.resume(thread, decision)`, `app.close()` — also on SIGTERM / SIGINT (#265 S51).
 */
export async function createApp<TApplication extends Class>(
  application: ApplicationClass<TApplication>,
  options: AppOptions = {},
): Promise<App> {
  const assembled = await applicationOf(application, options);
  const environment = await environmentFor(
    environmentOwnerOf(assembled),
    options,
    options.processEnv ?? process.env,
  );
  const built = await buildApplication(assembled, {
    ...options,
    ...(environment === undefined ? {} : { environment }),
  });
  closeOnStopSignals(built);
  return built.app;
}
