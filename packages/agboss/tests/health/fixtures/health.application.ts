import { Application } from "../../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  HealthCheck,
  HealthCheckResult,
  IdGenerator,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type HealthCheckHandler,
} from "../../../src/index.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import type { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import type { Tern } from "../../../src/terns/index.js";
import { seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { SharedCheckpointSaver } from "../../helpers/shared-infrastructure.js";

/**
 * #300 — an application with one project health check (a CRM client the tests mock), a cost
 * ledger the tests take down, execution records whose recovery look-up the tests make hang, and a
 * rate-limit store the tests reach to open a model provider's breaker for real.
 */

/** The test's levers (reset with `resetHealth`). */
export const levers = {
  /** The cost ledger's `ping()` rejects: the store is unreachable. */
  isLedgerDown: false,
  /** The recovery sweep's look-up waits until `releaseSweep()`. */
  isSweepStuck: false,
  releaseSweep: (): void => undefined,
};

/** The instance's rate-limit store, as created by its container. */
export const stores: { rateLimits: InMemoryRateLimitRepository | undefined } = {
  rateLimits: undefined,
};

export function resetHealth(): void {
  levers.releaseSweep();
  levers.isLedgerDown = false;
  levers.isSweepStuck = false;
  levers.releaseSweep = () => undefined;
  stores.rateLimits = undefined;
}

@Injectable()
export class CrmClient {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

@HealthCheck({ name: "crm-health-check", timeout: seconds(2), deps: [CrmClient] })
export class CrmHealthCheck implements HealthCheckHandler {
  constructor(private readonly crmClient: CrmClient) {}

  async check(): Promise<HealthCheckResult> {
    const isReachable: boolean = await this.crmClient.ping();
    return isReachable
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "CRM is unreachable" });
  }
}

@HealthCheck({ name: "search-health-check", timeout: seconds(1) })
export class SearchHealthCheck implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.degraded({ reason: "a replica is down" }));
  }
}

@Injectable()
export class FlakyCostLedgerRepository extends InMemoryCostLedgerRepository {
  override ping(): Promise<void> {
    return levers.isLedgerDown
      ? Promise.reject(new Error("connection refused"))
      : Promise.resolve();
  }
}

@Injectable({ deps: [Clock, IdGenerator] })
export class StallingExecutionRecordRepository extends InMemoryExecutionRecordRepository {
  override findByStatus(
    ...query: Parameters<InMemoryExecutionRecordRepository["findByStatus"]>
  ): Promise<Tern[]> {
    if (!levers.isSweepStuck) return super.findByStatus(...query);
    return new Promise<Tern[]>((resolve) => {
      levers.releaseSweep = () => {
        resolve([]);
      };
    });
  }
}

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class ReachableRateLimitRepository extends InMemoryRateLimitRepository {
  constructor(clock: Clock, applicationContext: ApplicationContext, database: InMemoryDatabase) {
    super(clock, applicationContext, database);
    stores.rateLimits = this;
  }
}

@WorkflowStart({
  name: "probe-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ProbeWorkflowStart {}

@Agent({
  name: "probe-agent",
  description: "Answers",
  prompt: "Answer.",
  model: "moonshotai/kimi-k2.6",
})
export class ProbeAgent {}

@WorkflowFinish({
  name: "probe-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ProbeWorkflowFinish {}

@Workflow({
  name: "probe-workflow",
  version: "1.0.0",
  flow: [
    start(ProbeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ProbeAgent)
      .toFinish(ProbeWorkflowFinish),
  ],
  providers: [CrmClient],
})
export class ProbeWorkflow {}

@Application({
  name: "probe-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ProbeWorkflow],
  budgets: TEST_BUDGETS,
  providers: [
    FlakyCostLedgerRepository,
    StallingExecutionRecordRepository,
    ReachableRateLimitRepository,
  ],
  healthChecks: [CrmHealthCheck, SearchHealthCheck],
})
export class ProbeApplication {}

/**
 * The same application without project checks — its readiness reads only the framework's own — on
 * a checkpoint saver without `ping()`.
 */
@Application({
  name: "plain-probe-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ProbeWorkflow],
  budgets: TEST_BUDGETS,
  // a checkpoint saver without ping(): readiness reads a thread that does not exist instead
  providers: [
    FlakyCostLedgerRepository,
    StallingExecutionRecordRepository,
    ReachableRateLimitRepository,
    SharedCheckpointSaver,
  ],
})
export class PlainProbeApplication {}
