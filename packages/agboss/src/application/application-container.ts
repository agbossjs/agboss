import {
  createContainer,
  UnavailableValue,
  type ApplicationContainer,
  type ContainerOptions,
} from "../components/container/container.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class, Token } from "../components/injection.js";
import type { Environment } from "../flow/generated-types.js";
import { CONTEXT_TOKENS, contextValuesOf } from "../components/context-tokens.js";
import { ComponentError } from "../components/metadata.js";
import { standaloneContexts, type RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { Clock } from "../infrastructure/clock.js";
import { IN_MEMORY_DATABASE, NEW_THREAD_ID } from "../infrastructure/instance-tokens.js";
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
  /** The instance's clock, created first (`clockOf`): every part of the instance reads it. */
  readonly clock: Clock;
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
  const { clock } = sources;
  return {
    modules: sources.modules,
    core: new Map<Token, unknown>([
      [Clock, clock],
      [NEW_THREAD_ID, sources.newThreadId],
      [IN_MEMORY_DATABASE, sources.database ?? new InMemoryDatabase()],
      ...contextValuesOf(sources.contexts),
    ]),
    defaults: INFRASTRUCTURE_DEFAULTS,
    // a listed clock asked for by its own class is the same instance
    instances: new Map([...(sources.instances ?? []), [clock.constructor as Class, clock]]),
  };
}

/** The contexts while the clock is created: they read their `startedAt` from it. */
const contextsNotYet = (): ReadonlyMap<Token, unknown> =>
  new Map(
    CONTEXT_TOKENS.map((token) => [
      token,
      new UnavailableValue(
        (dependant) =>
          `${dependant} cannot depend on the application's contexts: the Clock is created before them (their startedAt is read from it)`,
      ),
    ]),
  );

/**
 * The instance's clock (#262), created before anything else: the one class in
 * `@Application({ providers })` that `extends Clock`, else the system's. `onCreate` gets it (its
 * lifecycle hooks run with the others').
 */
export function clockOf(modules: readonly ProviderModule[], options: ContainerOptions = {}): Clock {
  const sources = { modules, core: contextsNotYet(), defaults: INFRASTRUCTURE_DEFAULTS };
  const clock = createContainer(sources, options).get(Clock);
  if (!(clock instanceof Clock)) throw new ComponentError("the application's Clock is not a Clock");
  return clock;
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

/** The one loaded application that lists the workflow (none: it stands alone, or two list it). */
function listingApplicationOf(bundle: AssembledWorkflow) {
  const [only, ...others] = applicationsListing(bundle.graph.type);
  return only === undefined || others.length > 0 ? undefined : applicationDeclarationOf(only);
}

/**
 * The budgets of a workflow run on its own (eval, replay, golden, compare): its application's
 * (#261), so those runs are checked and counted like the application's; none when it stands alone.
 */
export function standaloneBudgetsOf(
  bundle: AssembledWorkflow,
): { readonly budgets: readonly Class[]; readonly applicationName: string } | undefined {
  const declaration = listingApplicationOf(bundle);
  if (declaration === undefined) return undefined;
  const { options } = declaration;
  return { budgets: options.budgets ?? [], applicationName: options.name };
}

/** The providers of the one loaded application that lists the workflow (none: it stands alone). */
function applicationProvidersOf(bundle: AssembledWorkflow): ProviderModule {
  const declaration = listingApplicationOf(bundle);
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
export function standaloneInfrastructure(
  bundle: AssembledWorkflow,
  options: Pick<ApplicationContainerSources, "newThreadId"> & {
    readonly environment?: Environment | undefined;
  },
  onCreate?: (instance: unknown) => void,
): Infrastructure {
  const modules = [applicationProvidersOf(bundle)];
  const container = onCreate === undefined ? {} : { onCreate };
  const clock = clockOf(modules, container);
  return resolveInfrastructure(
    applicationContainerOf({
      modules,
      clock,
      newThreadId: options.newThreadId,
      contexts: standaloneContexts(bundle.config, options.environment, clock),
    }),
    container,
  );
}
