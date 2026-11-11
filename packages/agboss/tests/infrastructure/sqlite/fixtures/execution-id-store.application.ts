import { Application } from "../../../../src/application/application.js";
import { IN_MEMORY_DATABASE } from "../../../../src/infrastructure/in-memory-database.js";
import {
  InMemoryExecutionLeaseRepository,
  type StoreDescriptor,
} from "../../../../src/infrastructure/execution-lease.repository.js";
import {
  ApplicationContext,
  EXECUTION_ID_STORE,
  Injectable,
  provide,
  SqliteExecutionLeaseRepository,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionIdStore,
} from "../../../../src/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { ReleaseWorkflow } from "../../../app/fixtures/fence.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #891 AC2 — leases on a coordination backend (as Redis's), the execution ids they hand out kept by
 * the durable store the application gives under `EXECUTION_ID_STORE`.
 */
@Injectable({ deps: [StoreClock, ApplicationContext, IN_MEMORY_DATABASE, EXECUTION_ID_STORE] })
export class CoordinationLeases extends InMemoryExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    clock: StoreClock,
    applicationContext: ApplicationContext,
    database: ConstructorParameters<typeof InMemoryExecutionLeaseRepository>[2],
    private readonly ids: ExecutionIdStore,
  ) {
    super(clock, applicationContext, database);
  }

  override claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.ids.claimExecutionId(identity);
  }
}

/** The durable lease store under the token: created by the container, never `new`. */
export const DURABLE_IDS = provide(EXECUTION_ID_STORE, SqliteExecutionLeaseRepository);

@Application({
  name: "execution-id-store-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ReleaseWorkflow],
  budgets: TEST_BUDGETS,
  providers: [CoordinationLeases, DURABLE_IDS],
})
export class ExecutionIdStoreApplication {}
