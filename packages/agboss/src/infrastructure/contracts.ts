import { BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { Injectable } from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import { Clock, IdGenerator, RandomIdGenerator, SystemClock } from "./clock.js";
import { ConsoleLogger, Logger, SilentLogger } from "./logger.js";
import { CostLedgerRepository, InMemoryCostLedgerRepository } from "./cost-ledger.repository.js";
import {
  ExecutionRecordRepository,
  InMemoryExecutionRecordRepository,
} from "./execution-record.repository.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "./execution-lease.repository.js";
import {
  ExecutionTreeRepository,
  InMemoryExecutionTreeRepository,
} from "./execution-tree.repository.js";
import {
  InMemoryPausedExecutionRepository,
  PausedExecutionRepository,
} from "./paused-execution.repository.js";
import { InMemoryRateLimitRepository, RateLimitRepository } from "./rate-limit.repository.js";
import { InMemoryMeshRequestRepository, MeshRequestRepository } from "./mesh-request.repository.js";
import {
  ExecutionHistoryRepository,
  InMemoryExecutionHistoryRepository,
} from "./execution-history.repository.js";
import {
  ChildExecutionQueueRepository,
  InMemoryChildExecutionQueueRepository,
} from "./child-execution-queue.repository.js";
import { FencedEffectRepository } from "./fenced-effect.repository.js";
import { InMemoryFencedEffectRepository } from "./in-memory-fenced-effect.repository.js";
import {
  ExecutionLeaseEventRepository,
  InMemoryExecutionLeaseEventRepository,
} from "./execution-lease-event.repository.js";
import { OutboundCallRepository } from "./outbound-call.repository.js";
import { InMemoryOutboundCallRepository } from "./outbound-call.repository.js";
import { isSqliteImplementation } from "./sqlite/sqlite-connection.js";
import { OutboundCalls } from "../app/outbound-calls.js";

/**
 * The infrastructure an application consumes (#261, S28; the shared contracts #265): a framework
 * contract with a built-in default, one per application. Registered only in `@Application({ providers })`; the
 * implementation is found by inheritance — none listed → the default, two → ambiguous.
 */

/** The default checkpointer: LangGraph's `MemorySaver` — a pause is lost on restart. */
@Injectable()
export class InMemoryCheckpointSaver extends MemorySaver {
  /** In memory, always reachable (#300). */
  ping(): Promise<void> {
    return Promise.resolve();
  }
}

/** Each contract with its built-in default (in memory: nothing is written to disk). */
export const INFRASTRUCTURE_DEFAULTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  [Clock, SystemClock],
  [IdGenerator, RandomIdGenerator],
  [Logger, ConsoleLogger],
  [BaseCheckpointSaver, InMemoryCheckpointSaver],
  [ExecutionRecordRepository, InMemoryExecutionRecordRepository],
  [CostLedgerRepository, InMemoryCostLedgerRepository],
  [PausedExecutionRepository, InMemoryPausedExecutionRepository],
  [ExecutionLeaseRepository, InMemoryExecutionLeaseRepository],
  [ExecutionTreeRepository, InMemoryExecutionTreeRepository],
  [RateLimitRepository, InMemoryRateLimitRepository],
  [MeshRequestRepository, InMemoryMeshRequestRepository],
  [ExecutionHistoryRepository, InMemoryExecutionHistoryRepository],
  [ChildExecutionQueueRepository, InMemoryChildExecutionQueueRepository],
  [FencedEffectRepository, InMemoryFencedEffectRepository],
  [ExecutionLeaseEventRepository, InMemoryExecutionLeaseEventRepository],
  [OutboundCallRepository, InMemoryOutboundCallRepository],
]);

/**
 * The defaults of a test's application (`testWith`): the same, except that an unlisted `Logger` is
 * silent — a test reads the log through a `Logger` its application lists.
 */
export const TEST_INFRASTRUCTURE_DEFAULTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  ...INFRASTRUCTURE_DEFAULTS,
  [Logger, SilentLogger],
]);

/**
 * The framework's services a component injects without listing them (#505: `OutboundCalls`),
 * created by the application's container over its infrastructure — never infrastructure itself.
 */
const CORE_SERVICES: readonly (readonly [Class, Class])[] = [[OutboundCalls, OutboundCalls]];

/** What an application's container creates when nothing listed provides it. */
export const CONTAINER_DEFAULTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  ...INFRASTRUCTURE_DEFAULTS,
  ...CORE_SERVICES,
]);

/** The same for a test's application: an unlisted `Logger` is silent. */
export const TEST_CONTAINER_DEFAULTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  ...TEST_INFRASTRUCTURE_DEFAULTS,
  ...CORE_SERVICES,
]);

/** Whether `cls` is `contract` or extends it. */
const extendsContract = (cls: Class, contract: Class): boolean =>
  cls === contract || Object.prototype.isPrototypeOf.call(contract.prototype, cls.prototype);

/** The infrastructure contract a class implements, if any. */
export const infrastructureContractOf = (cls: Class): Class | undefined =>
  [...INFRASTRUCTURE_DEFAULTS.keys()].find((contract) => extendsContract(cls, contract));

/** What an application instance runs on: one instance per contract. */
export interface Infrastructure {
  /** The instance's time (#262): the listed `Clock`, else the system's; a test's `VirtualClock`. */
  readonly clock: Clock;
  /** The ids it mints (#313): the listed `IdGenerator`, else random; a test's sequential one. */
  readonly idGenerator: IdGenerator;
  /** Where the framework's log goes: the listed `Logger`, else `ConsoleLogger` (standard error). */
  readonly logger: Logger;
  readonly checkpointer: BaseCheckpointSaver;
  readonly records: ExecutionRecordRepository;
  readonly costLedger: CostLedgerRepository;
  readonly pausedExecutions: PausedExecutionRepository;
  readonly executionLeases: ExecutionLeaseRepository;
  readonly executionTrees: ExecutionTreeRepository;
  readonly rateLimits: RateLimitRepository;
  readonly meshRequests: MeshRequestRepository;
  /** The kept root executions (#401 PR 1): written only with `executionRecordRetention`. */
  readonly executionHistory: ExecutionHistoryRepository;
  /** The children queued for any instance (#333 PR 2, `ChildPlacement.AnyInstance`). */
  readonly childQueue: ChildExecutionQueueRepository;
  /** The protected writes of steps (#500): their results and the scopes' marks. */
  readonly fencedEffects: FencedEffectRepository<unknown>;
  /** The lease log (#501): takeovers and hand-overs, always written. */
  readonly leaseEvents: ExecutionLeaseEventRepository;
  /** The intents of calls that leave the system (#505): recorded before each is sent. */
  readonly outboundCalls: OutboundCallRepository;
  /**
   * What the holders of leases take and renew them in, and their timers (the background renewal,
   * the local expiry) sleep on — a test's `leases.stall` gate (#471); absent = `executionLeases` on
   * `clock`. Readiness pings `executionLeases` itself.
   */
  readonly leasing?: Leasing;
}

/** The lease store and clock the holders of leases use (#471). */
export interface Leasing {
  readonly repository: ExecutionLeaseRepository;
  readonly clock: Clock;
}

/** The lease store and clock of an instance's lease holders. */
export const leasingOf = (infrastructure: Infrastructure): Leasing =>
  infrastructure.leasing ?? {
    repository: infrastructure.executionLeases,
    clock: infrastructure.clock,
  };

/** The infrastructure from the application's container (a listed class, else the default). */
export const infrastructureOf = (resolve: (contract: Class) => unknown): Infrastructure => ({
  clock: resolve(Clock) as Clock,
  idGenerator: resolve(IdGenerator) as IdGenerator,
  logger: resolve(Logger) as Logger,
  // each contract resolves to an instance of a class that extends it (registrations by inheritance)
  checkpointer: resolve(BaseCheckpointSaver) as BaseCheckpointSaver,
  records: resolve(ExecutionRecordRepository) as ExecutionRecordRepository,
  costLedger: resolve(CostLedgerRepository) as CostLedgerRepository,
  pausedExecutions: resolve(PausedExecutionRepository) as PausedExecutionRepository,
  executionLeases: resolve(ExecutionLeaseRepository) as ExecutionLeaseRepository,
  executionTrees: resolve(ExecutionTreeRepository) as ExecutionTreeRepository,
  rateLimits: resolve(RateLimitRepository) as RateLimitRepository,
  meshRequests: resolve(MeshRequestRepository) as MeshRequestRepository,
  executionHistory: resolve(ExecutionHistoryRepository) as ExecutionHistoryRepository,
  childQueue: resolve(ChildExecutionQueueRepository) as ChildExecutionQueueRepository,
  fencedEffects: resolve(FencedEffectRepository) as FencedEffectRepository<unknown>,
  leaseEvents: resolve(ExecutionLeaseEventRepository) as ExecutionLeaseEventRepository,
  outboundCalls: resolve(OutboundCallRepository) as OutboundCallRepository,
});

/**
 * The parts a later app of the same test reuses as they are (`recoverApp()`, a second instance):
 * the stores of #261. The shared contracts are created per instance — their in-memory defaults
 * keep their rows in the test's one `InMemoryDatabase`, each instance with its own id — and so is
 * every SQLite implementation: its rows are in the file, each instance opens its own connection.
 */
const REUSED_PARTS = ["checkpointer", "records", "costLedger", "pausedExecutions"] as const;

/** The instances a later app of the same test reuses, by their class. */
export const reusableInfrastructure = (
  infrastructure: Infrastructure,
): ReadonlyMap<Class, unknown> =>
  new Map(
    REUSED_PARTS.flatMap((part) => {
      const instance: object = infrastructure[part];
      return isSqliteImplementation(instance) ? [] : [[instance.constructor as Class, instance]];
    }),
  );
