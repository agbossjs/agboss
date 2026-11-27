/**
 * Two loaded `@Application` classes list one workflow (a CLI process that loads several): outside
 * an application (`agboss check --application`) each assembled bundle gets the storage of the
 * application that assembled it, not none because two list the workflow (#1324).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import {
  Action,
  DatabaseStorage,
  Injectable,
  SqliteDriver,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { SqliteConnection } from "../../src/stores/index.js";
import { onStart, toFinish } from "../helpers/flow.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createStartComponents } from "../../src/app/start-components.js";
import { contextsOutsideExecution } from "../../src/flow/context/runtime-contexts.js";
import { describeServices } from "../../src/describe/describe-workflow.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { days } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

const folder = mkdtempSync(join(tmpdir(), "agboss-two-applications-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A repository on the storage's connection: it cannot be built without it. */
@Injectable({ deps: [SqliteConnection] })
class SharedLedger {
  constructor(readonly connection: SqliteConnection) {
    connection.ensureSchema("shared-ledger", "CREATE TABLE IF NOT EXISTS shared_ledger (id TEXT)");
  }
}

@WorkflowStart({
  name: "shared-ledger-start-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
class SharedLedgerStart {}

@Action({
  name: "shared-ledger-action",
  description: "Reads the ledger",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [SharedLedger],
})
class SharedLedgerAction {
  constructor(private readonly ledger: SharedLedger) {}
  async execute() {
    return { text: this.ledger.constructor.name };
  }
}

@WorkflowFinish({
  name: "shared-ledger-finish-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class SharedLedgerFinish {}

@Workflow({
  name: "shared-ledger-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(SharedLedgerStart).toAction(SharedLedgerAction).toFinish(SharedLedgerFinish)],
})
class SharedLedgerWorkflow {}

@DatabaseStorage({
  driver: SqliteDriver({ path: join(folder, "shared.sqlite") }),
  auditLogTtl: days(90),
  ledgerEntriesTtl: days(30),
})
class SharedDatabaseStorage {}

@Application({
  name: "with-storage-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [SharedLedgerWorkflow],
  budgets: TEST_BUDGETS,
  storage: SharedDatabaseStorage,
})
class WithStorageApplication {}

@Application({
  name: "without-storage-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [SharedLedgerWorkflow],
  budgets: TEST_BUDGETS,
})
class WithoutStorageApplication {}

const startComponentsOf = async (application: new () => unknown): Promise<void> => {
  const assembled = await applicationOf(application, { processEnv: {} });
  for (const bundle of assembled.workflows)
    createStartComponents(bundle, {
      router: describeServices.router,
      contexts: contextsOutsideExecution(bundle.config),
    });
};

describe("a workflow listed by two loaded applications, outside an application", () => {
  it("gives each bundle the storage of the application that assembled it", async () => {
    await expect(startComponentsOf(WithStorageApplication)).resolves.toBeUndefined();
    await expect(startComponentsOf(WithoutStorageApplication)).rejects.toBeInstanceOf(
      ConfigError.Option,
    );
  });
});
