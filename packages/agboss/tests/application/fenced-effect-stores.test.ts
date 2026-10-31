/**
 * #500, #526 — the fenced-effect store and the lease store are on one backend: a listed store's
 * `static backend` must be the application's lease store's (listed, else the in-memory default),
 * else `[application.store-backend-mismatch]` names both (every pairing: store-backends.test.ts);
 * a store of a project that declares none fails `[application.store-backend-undeclared]` (it used
 * to be skipped, #526); an unlisted default beside SQLite leases fails at its first call
 * (`FencedEffectStoreMismatchError`).
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import {
  ActionFailedError,
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  FencedEffectRepository,
  FencedEffectStoreMismatchError,
  InMemoryFencedEffectRepository,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { MortalExecutionLeaseRepository } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { UnlistedFencedEffectStoreApplication } from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import {
  DoubleChargeWorkflowStart,
  resetFencedEffect,
} from "../app/fixtures/fenced-effect.workflow.js";
import { ReleaseWorkflow } from "../app/fixtures/fence.workflow.js";

sqliteFilePerTest();

/** A project's own store that declares no backend (#526: it fails assembly). */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
class OwnFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly leaseRepository = undefined;
  static override readonly backend = undefined;
}

const assembledWith = (providers: readonly Provider[]) => {
  @Application({
    name: "stores-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
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
      environment: SqliteTestEnvironment,
      workflows: [ReleaseWorkflow],
      budgets: TEST_BUDGETS,
      providers: [OwnFencedEffectRepository, SqliteExecutionLeaseRepository, SqliteConnection],
    })
    class OwnStoreApplication {}

    await expect(applicationOf(OwnStoreApplication)).rejects.toThrow(
      "[application.store-backend-undeclared] OwnFencedEffectRepository declares no backend",
    );
    expect(FencedEffectRepository.backend).toBeUndefined();
  });
});

describe("#500: the unlisted default beside SQLite leases", () => {
  testWith(UnlistedFencedEffectStoreApplication)(
    "is not an assembly error; the first call fails with FencedEffectStoreMismatchError",
    async ({ app }) => {
      resetFencedEffect();

      const error = await execute(app, DoubleChargeWorkflowStart, { text: "order-1" }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ActionFailedError);
      expect(error).toMatchObject({ cause: expect.any(FencedEffectStoreMismatchError) });
      expect(error).toMatchObject({
        cause: {
          code: "fenced-effect.store-mismatch",
          fencedEffectRepository: "InMemoryFencedEffectRepository",
          leaseRepository: "SqliteExecutionLeaseRepository",
        },
      });
    },
  );
});
