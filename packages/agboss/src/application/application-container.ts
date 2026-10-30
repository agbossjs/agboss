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
import { Clock, IdGenerator } from "../infrastructure/clock.js";
import { IN_MEMORY_DATABASE } from "../infrastructure/instance-tokens.js";
import { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import {
  FencedEffectSettings,
  OutboundCallSettings,
} from "../infrastructure/fenced-effect-settings.js";
import {
  CONTAINER_DEFAULTS,
  INFRASTRUCTURE_DEFAULTS,
  TEST_CONTAINER_DEFAULTS,
  infrastructureOf,
  type Infrastructure,
} from "../infrastructure/contracts.js";
import type { AssembledWorkflow } from "../workflow.js";
import { containerProvidersOf } from "../models/resolution.js";
import { applicationDeclarationOf, applicationsListing } from "./application.js";

/** What the shared container of an application instance is built from besides its providers. */
export interface ApplicationContainerSources {
  readonly modules: readonly ProviderModule[];
  /** The instance's clock, created first (`clockOf`): every part of the instance reads it. */
  readonly clock: Clock;
  /**
   * The ids of a test's instance (#313, shared by its instances): used unless the application
   * lists an `IdGenerator`. Resolved before the stores, which inject it (`idGeneratorOf`).
   */
  readonly idGenerator?: IdGenerator | undefined;
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
  /** A test's instance (`testWith`): an unlisted `Logger` is silent. */
  readonly quiet?: boolean | undefined;
  /** `@Application({ fencedEffects })` (#500), as the fenced-effect store reads it; else the defaults. */
  readonly fencedEffects?: FencedEffectSettings | undefined;
  /** `@Application({ outboundCalls })` (#505), as `OutboundCalls` and its store read it. */
  readonly outboundCalls?: OutboundCallSettings | undefined;
}

/** The parts every container of one application instance shares (one instance per class). */
export function applicationContainerOf(
  sources: ApplicationContainerSources,
  options: ContainerOptions = {},
): ApplicationContainer {
  const { clock } = sources;
  const idGenerator = idGeneratorOf(sources.modules, options, sources.idGenerator);
  return {
    modules: sources.modules,
    core: new Map<Token, unknown>([
      [Clock, clock],
      [IdGenerator, idGenerator],
      [IN_MEMORY_DATABASE, sources.database ?? new InMemoryDatabase()],
      [FencedEffectSettings, sources.fencedEffects ?? new FencedEffectSettings()],
      [OutboundCallSettings, sources.outboundCalls ?? new OutboundCallSettings()],
      ...contextValuesOf(sources.contexts),
    ]),
    defaults: sources.quiet === true ? TEST_CONTAINER_DEFAULTS : CONTAINER_DEFAULTS,
    // a listed clock or id generator asked for by its own class is the same instance
    instances: new Map([
      ...(sources.instances ?? []),
      [clock.constructor as Class, clock],
      [idGenerator.constructor as Class, idGenerator],
    ]),
  };
}

/** The contexts while the clock is created: they read their `startedAt` from it. */
const contextsNotYet = (why: string): ReadonlyMap<Token, unknown> =>
  new Map(
    CONTEXT_TOKENS.map((token) => [
      token,
      new UnavailableValue(
        (dependant) => `${dependant} cannot depend on the application's contexts: ${why}`,
      ),
    ]),
  );

/**
 * The instance's clock (#262), created before anything else: the one class in
 * `@Application({ providers })` that `extends Clock`, else the system's. `onCreate` gets it (its
 * lifecycle hooks run with the others').
 */
export function clockOf(modules: readonly ProviderModule[], options: ContainerOptions = {}): Clock {
  const core = contextsNotYet("the Clock is created before them (their startedAt is read from it)");
  const sources = { modules, core, defaults: INFRASTRUCTURE_DEFAULTS };
  const clock = createContainer(sources, options).get(Clock);
  if (!(clock instanceof Clock)) throw new ComponentError("the application's Clock is not a Clock");
  return clock;
}

/**
 * The instance's id generator (#313), created before the stores that inject it: the one class in
 * `@Application({ providers })` that `extends IdGenerator`, else `fallback` (a test's sequential
 * one, shared by its instances), else `RandomIdGenerator`. It may not depend on the contexts.
 */
export function idGeneratorOf(
  modules: readonly ProviderModule[],
  options: ContainerOptions = {},
  fallback?: IdGenerator,
): IdGenerator {
  const core = contextsNotYet("the IdGenerator is created before the stores that inject it");
  const own = fallback?.constructor as Class | undefined;
  const defaults = new Map<Class, Class>([
    ...INFRASTRUCTURE_DEFAULTS,
    ...(own === undefined ? [] : [[IdGenerator, own] as const]),
  ]);
  const instances = new Map<Token, unknown>(own === undefined ? [] : [[own, fallback]]);
  const application = { modules: [], core: new Map<Token, unknown>(), defaults, instances };
  const container = createContainer({ modules, core, defaults }, { ...options, application });
  const generator = container.get(IdGenerator);
  if (!(generator instanceof IdGenerator)) {
    throw new ComponentError("the application's IdGenerator is not an IdGenerator");
  }
  return generator;
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

/**
 * Instances of listed classes from the application's container (its observers): created now, once
 * each, with their lifecycle hooks (`options.onCreate`) — a test's mock replaces one.
 */
export function resolveListed(
  application: ApplicationContainer,
  options: ContainerOptions,
  classes: readonly Class[],
): unknown[] {
  const container = createContainer({ modules: [], core: new Map() }, { ...options, application });
  return classes.map((cls) => container.get(cls));
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
  options: {
    readonly environment?: Environment | undefined;
  },
  onCreate?: (instance: unknown) => void,
): Infrastructure {
  const modules = [applicationProvidersOf(bundle)];
  const container = onCreate === undefined ? {} : { onCreate };
  const clock = clockOf(modules, container);
  return resolveInfrastructure(
    applicationContainerOf(
      { modules, clock, contexts: standaloneContexts(bundle.config, options.environment, clock) },
      container,
    ),
    container,
  );
}
