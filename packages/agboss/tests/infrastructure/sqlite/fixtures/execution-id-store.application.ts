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
import { sqliteTestStorage } from "./sqlite-test-storage.js";
import { ClusterStorage } from "../../../../src/index.js";
import { defineStorageDriver, StorageRole } from "../../../../src/storage/storage-driver.js";

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

/** The durable lease store under the token (for the assembly rules' tests): created by the container, never `new`. */
export const DURABLE_IDS = provide(EXECUTION_ID_STORE, SqliteExecutionLeaseRepository);

/** The coordination backend's cluster storage: its leases are `CoordinationLeases`, the ids stay in the database's lease row. */
@ClusterStorage({
  name: "coordination-cluster-storage",
  driver: defineStorageDriver({
    role: StorageRole.Cluster,
    backend: "redis",
    describes: "coordination leases (in memory)",
    settings: { kind: "in-memory" },
    providers: [CoordinationLeases],
  }),
})
export class CoordinationCluster {}

@Application({
  name: "execution-id-store-application",
  version: "1.0.0",
  storage: { database: sqliteTestStorage(), cluster: CoordinationCluster },
  workflows: [ReleaseWorkflow],
  budgets: TEST_BUDGETS,
})
export class ExecutionIdStoreApplication {}
