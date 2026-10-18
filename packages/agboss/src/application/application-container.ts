import {
  createContainer,
  type ApplicationContainer,
  type ContainerOptions,
} from "../components/container/container.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class, Token } from "../components/injection.js";
import type { Clock } from "../finops/ledger.js";
import type { Environment } from "../flow/generated-types.js";
import { contextValuesOf } from "../components/context-tokens.js";
import { standaloneContexts, type RuntimeContexts } from "../flow/context/runtime-contexts.js";
import {
  INFRASTRUCTURE_CLOCK,
  INSTANCE_ID,
  IN_MEMORY_DATABASE,
  NEW_THREAD_ID,
} from "../infrastructure/clock.js";
import { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  infrastructureOf,
  type Infrastructure,
} from "../infrastructure/contracts.js";
import type { NewThreadId } from "../terns/index.js";
import type { AssembledWorkflow } from "../workflow.js";
import { containerProvidersOf } from "../models/resolution.js";
import { applicationDeclarationOf, applicationsListing } from "./application.js";

/** What the shared container of an application instance is built from besides its providers. */
export interface ApplicationContainerSources {
  readonly modules: readonly ProviderModule[];
  readonly clock?: Clock | undefined;
  readonly newThreadId?: NewThreadId | undefined;
  /**
   * The instance's context levels (#261): its `ApplicationContext` — whose `instanceId` is the
   * holder of its leases (#265 S63) — and the declared context classes.
   */
  readonly contexts: RuntimeContexts;
  /** Where the in-memory defaults keep their rows; a new one unless a test shares one. */
  readonly database?: InMemoryDatabase | undefined;
  /**
   * Instances an earlier app of the same test already created (its infrastructure): reused, so a
   * paused execution survives `recoverApp()`. Empty in production.
   */
  readonly instances?: ReadonlyMap<Class, unknown>;
}

/** The parts every container of one application instance shares (one instance per class). */
export function applicationContainerOf(sources: ApplicationContainerSources): ApplicationContainer {
  return {
    modules: sources.modules,
    core: new Map<Token, unknown>([
      [INFRASTRUCTURE_CLOCK, sources.clock ?? ((): Date => new Date())],
      [NEW_THREAD_ID, sources.newThreadId],
      [INSTANCE_ID, sources.contexts.application.instanceId],
      [IN_MEMORY_DATABASE, sources.database ?? new InMemoryDatabase()],
      ...contextValuesOf(sources.contexts),
    ]),
    defaults: INFRASTRUCTURE_DEFAULTS,
    instances: new Map(sources.instances ?? []),
  };
}

/**
 * The application's infrastructure, from its container: each contract's listed implementation,
 * else the built-in default. Created before any workflow, so every workflow shares the instances.
 */
export function resolveInfrastructure(
  application: ApplicationContainer,
  options: ContainerOptions,
): Infrastructure {
  const container = createContainer({ modules: [], core: new Map() }, { ...options, application });
  return infrastructureOf((contract) => container.get(contract));
}

/** The providers of the one loaded application that lists the workflow (none: it stands alone). */
function applicationProvidersOf(bundle: AssembledWorkflow): ProviderModule {
  const [only, ...others] = applicationsListing(bundle.graph.type);
  const declaration =
    only === undefined || others.length > 0 ? undefined : applicationDeclarationOf(only);
  if (declaration === undefined) return { owner: bundle.config.name, providers: [] };
  const { options } = declaration;
  return {
    owner: options.name,
    declaredIn: "@Application",
    providers: containerProvidersOf(options.providers),
  };
}

/**
 * The infrastructure of a workflow run on its own (eval, replay, golden, compare): its
 * application's — the implementations it lists (its SQLite file, so records persist across
 * processes, #265), else the built-in in-memory defaults. `onCreate` gets every instance created
 * (their lifecycle hooks: a SQLite connection is closed at the end).
 */
export const standaloneInfrastructure = (
  bundle: AssembledWorkflow,
  options: Pick<ApplicationContainerSources, "clock" | "newThreadId"> & {
    readonly environment?: Environment | undefined;
  },
  onCreate?: (instance: unknown) => void,
): Infrastructure =>
  resolveInfrastructure(
    applicationContainerOf({
      modules: [applicationProvidersOf(bundle)],
      clock: options.clock,
      newThreadId: options.newThreadId,
      contexts: standaloneContexts(bundle.config, options.environment),
    }),
    onCreate === undefined ? {} : { onCreate },
  );
