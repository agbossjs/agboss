import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import type { StoreDescriptor } from "../../src/infrastructure/execution-lease.repository.js";
/**
 * #500, #526 — the fenced-effect store and the lease store are on one backend: a listed store's
 * `static backend` must be the application's lease store's (listed, else the in-memory default),
 * else `[application.store-backend-mismatch]` names both (every pairing: store-backends.test.ts);
 * a store of a project that declares none fails `[application.store-backend-undeclared]` (it used
 * to be skipped, #526); an unlisted default beside SQLite leases fails at its first call
 * (`IdempotencyError.StoreMismatch`).
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import {
  Clock,
  StoreClock,
  ExecutionLeaseRepository,
  FencedEffectRepository,
  InMemoryFencedEffectRepository,
  Injectable,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
} from "../../src/index.js";
import { SqliteConnection } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { MortalExecutionLeaseRepository } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { UnlistedFencedEffectStoreApplication } from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import {
  DoubleChargeWorkflowStart,
  resetFencedEffect,
} from "../app/fixtures/fenced-effect.workflow.js";
import { ReleaseWorkflow } from "../app/fixtures/fence.workflow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

sqliteFilePerTest();

/** A project's own store that declares no backend (#526: it fails assembly). */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository],
})
class OwnFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly store: StoreDescriptor = { backend: undefined };
}

const assembledWith = (providers: readonly Provider[]) => {
  @Application({
    name: "stores-application",
    modelProvider: TestModelProvider,
    version: "1.0.0",
    workflows: [ReleaseWorkflow],
    budgets: TEST_BUDGETS,
    providers: [SqliteConnection, ...providers],
  })
  class StoresApplication {}
  return applicationOf(StoresApplication);
};

describe("#500, #526: the fenced-effect store beside its lease store", () => {
  it("the SQLite store beside the in-memory leases fails assembly, naming both backends", async () => {
    await expect(assembledWith([SqliteFencedEffectRepository])).rejects.toThrow(
      '[application.store-backend-mismatch] SqliteFencedEffectRepository (backend "sqlite") checks its leases in its own transaction, but the application\'s leases are in InMemoryExecutionLeaseRepository (backend "in-memory")',
    );
  });

  it("the SQLite store with the SQLite leases assembles", async () => {
    const assembled = await assembledWith([
      SqliteFencedEffectRepository,
      SqliteExecutionLeaseRepository,
    ]);

    expect(assembled.providers).toContain(SqliteFencedEffectRepository);
  });

  it("a subclass of a lease store is on its backend", async () => {
    await expect(
      assembledWith([InMemoryFencedEffectRepository, MortalExecutionLeaseRepository]),
    ).resolves.toBeDefined();
  });

  it("the in-memory store beside the SQLite leases fails assembly", async () => {
    await expect(
      assembledWith([InMemoryFencedEffectRepository, SqliteExecutionLeaseRepository]),
    ).rejects.toThrow(
      'InMemoryFencedEffectRepository (backend "in-memory") checks its leases in its own transaction, but the application\'s leases are in SqliteExecutionLeaseRepository (backend "sqlite")',
    );
  });

  it("regression #526: a store that declares no backend is no longer skipped — it fails assembly", async () => {
    @Application({
      name: "own-store-application",
      version: "1.0.0",
      workflows: [ReleaseWorkflow],
      budgets: TEST_BUDGETS,
      providers: [OwnFencedEffectRepository, SqliteExecutionLeaseRepository, SqliteConnection],
    })
    class OwnStoreApplication {}

    await expect(applicationOf(OwnStoreApplication)).rejects.toThrow(
      "[application.store-backend-undeclared] OwnFencedEffectRepository declares no backend",
    );
    expect(FencedEffectRepository.store.backend).toBeUndefined();
  });
});

describe("#500: the unlisted default beside SQLite leases", () => {
  testWith(UnlistedFencedEffectStoreApplication)(
    "is not an assembly error; the first call fails with IdempotencyError.StoreMismatch",
    async ({ app }) => {
      resetFencedEffect();

      const error = await execute(app, DoubleChargeWorkflowStart, { text: "order-1" }).catch(
        (thrown: unknown) => thrown,
      );

      // a family's error is not wrapped by the action's step (decision 8)
      expect(error).toBeInstanceOf(IdempotencyError.StoreMismatch);
      expect(error).toMatchObject({
        code: "idempotency.store-mismatch",
        fencedEffectRepository: "InMemoryFencedEffectRepository",
        leaseRepository: "SqliteExecutionLeaseRepository",
      });
    },
  );
});
