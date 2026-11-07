/**
 * #824 — A2A task stores on every backend the assembly rule pairs with a lease store: the core's own
 * (in-memory, SQLite) and stores of other backends ("postgres", "postgres:billing", "mongodb") and
 * ones that declare none or an empty one. They are the in-memory store underneath: only their
 * declarations are read at assembly.
 */
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { Application } from "../../../src/application/application.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { ApplicationContext, Clock, StoreClock, Injectable } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { SqliteTestEnvironment } from "../../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { ReleaseWorkflow, ReleaseWorkflowStart } from "../../app/fixtures/fence.workflow.js";
import type { StoreDescriptor } from "../../../src/index.js";

const TASK_DEPS = { deps: [IN_MEMORY_DATABASE] } as const;
const LEASE_DEPS = { deps: [StoreClock, ApplicationContext, IN_MEMORY_DATABASE] } as const;

@Injectable(TASK_DEPS)
export class PostgresA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "postgres" };
}

@Injectable(TASK_DEPS)
export class BillingA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "postgres:billing" };
}

@Injectable(TASK_DEPS)
export class MongoA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "mongodb" };
}

@Injectable(TASK_DEPS)
export class UndeclaredA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: undefined };
}

@Injectable(TASK_DEPS)
export class EmptyA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "" };
}

/** A backend no rule knows: shared or not, assembly cannot tell — refused beside other leases. */
@Injectable(TASK_DEPS)
export class LmdbA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "lmdb" };
}

/** A known kind, written in another case: not the kind it looks like. */
@Injectable(TASK_DEPS)
export class CapitalSqliteA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "SQLite" };
}

/** A project's own in-memory subclass: still each instance's own memory. */
@Injectable(TASK_DEPS)
export class OwnInMemoryA2ATasks extends InMemoryA2ATaskRepository {}

@Injectable(LEASE_DEPS)
export class MongoLeases extends InMemoryExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "mongodb" };
}

@A2AExpose({
  name: "release-a2a-expose",
  version: "1.0.0",
  description: "Releases",
  exports: [ReleaseWorkflowStart],
})
export class ReleaseA2AExpose {}

/** An application listing `providers`, exposing a start over A2A or not. */
export function a2aStoresApplication(
  providers: readonly Provider[],
  { isExposed = true }: { readonly isExposed?: boolean } = {},
): Class {
  @Application({
    name: "a2a-stores-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: [ReleaseWorkflow],
    budgets: TEST_BUDGETS,
    providers,
    ...(isExposed ? { exposes: [ReleaseA2AExpose] } : {}),
  })
  class A2AStoresApplication {}
  return A2AStoresApplication;
}
