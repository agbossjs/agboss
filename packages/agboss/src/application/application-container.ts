import {
  createContainer,
  type ApplicationContainer,
  type ContainerOptions,
} from "../components/container/container.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class, Token } from "../components/injection.js";
import type { Clock } from "../finops/ledger.js";
import { randomUUID } from "node:crypto";
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

/** What the shared container of an application instance is built from besides its providers. */
export interface ApplicationContainerSources {
  readonly modules: readonly ProviderModule[];
  readonly clock?: Clock | undefined;
  readonly newThreadId?: NewThreadId | undefined;
  /** The instance's id (the holder of its leases); random unless a test names it. */
  readonly instanceId?: string | undefined;
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
      [INSTANCE_ID, sources.instanceId ?? randomUUID()],
      [IN_MEMORY_DATABASE, sources.database ?? new InMemoryDatabase()],
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

/** The infrastructure of a workflow run on its own (eval, replay): the built-in defaults. */
export const standaloneInfrastructure = (
  bundle: AssembledWorkflow,
  options: Pick<ApplicationContainerSources, "clock" | "newThreadId">,
): Infrastructure =>
  resolveInfrastructure(
    applicationContainerOf({
      modules: [{ owner: bundle.config.name, providers: [] }],
      clock: options.clock,
      newThreadId: options.newThreadId,
    }),
    {},
  );
