/**
 * #500 — the fenced-effect store and the lease store are of one database: a listed store's
 * `static leaseRepository` must be the application's lease store (listed, else the in-memory
 * default), else `[application.fenced-effect-lease-store]` names both classes; a store of a project
 * that declares none is not checked, and an unlisted default beside SQLite leases fails at its first
 * call (`FencedEffectStoreMismatchError`).
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/instance-tokens.js";
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

/** A project's own store that names no lease store: not checked at assembly. */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
class OwnFencedEffectRepository extends InMemoryFencedEffectRepository {
  static override readonly leaseRepository = undefined;
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

describe("#500: [application.fenced-effect-lease-store]", () => {
  it("the SQLite store beside the in-memory leases fails assembly, naming both", async () => {
    await expect(assembledWith([SqliteFencedEffectRepository])).rejects.toThrow(
      "[application.fenced-effect-lease-store] SqliteFencedEffectRepository checks the leases of SqliteExecutionLeaseRepository, but the application's leases are in InMemoryExecutionLeaseRepository",
    );
  });

  it("the SQLite store with the SQLite leases assembles", async () => {
    const assembled = await assembledWith([
      SqliteFencedEffectRepository,
      SqliteExecutionLeaseRepository,
    ]);

    expect(assembled.providers).toContain(SqliteFencedEffectRepository);
  });

  it("a subclass of the lease store it reads is that store", async () => {
    await expect(
      assembledWith([InMemoryFencedEffectRepository, MortalExecutionLeaseRepository]),
    ).resolves.toBeDefined();
  });

  it("the in-memory store beside the SQLite leases fails assembly", async () => {
    await expect(
      assembledWith([InMemoryFencedEffectRepository, SqliteExecutionLeaseRepository]),
    ).rejects.toThrow(
      "InMemoryFencedEffectRepository checks the leases of InMemoryExecutionLeaseRepository, but the application's leases are in SqliteExecutionLeaseRepository",
    );
  });

  it("a store that declares no lease store is not checked", async () => {
    @Application({
      name: "own-store-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [ReleaseWorkflow],
      budgets: TEST_BUDGETS,
      providers: [OwnFencedEffectRepository, SqliteExecutionLeaseRepository, SqliteConnection],
    })
    class OwnStoreApplication {}

    await expect(applicationOf(OwnStoreApplication)).resolves.toBeDefined();
    expect(FencedEffectRepository.leaseRepository).toBeUndefined();
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
