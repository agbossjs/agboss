/**
 * `studioOf` assembles the application's storage as `createApp` does: a workflow whose components
 * are on `SqliteConnection` renders in Studio on an `@Application({ storage })` with a SQLite driver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import {
  Action,
  DatabaseStorage,
  EmptyEnvironment,
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
import { studioOfWith } from "../../src/studio.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { days } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

const folder = mkdtempSync(join(tmpdir(), "agboss-studio-storage-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A repository on the storage's connection: it cannot be built without it. */
@Injectable({ deps: [SqliteConnection] })
class StudioLedger {
  constructor(readonly connection: SqliteConnection) {
    connection.ensureSchema("studio-ledger", "CREATE TABLE IF NOT EXISTS studio_ledger (id TEXT)");
  }
}

@WorkflowStart({
  name: "studio-ledger-start-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
class StudioLedgerStart {}

@Action({
  name: "studio-ledger-action",
  description: "Reads the ledger",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [StudioLedger],
})
class StudioLedgerAction {
  constructor(private readonly ledger: StudioLedger) {}
  async execute() {
    return { text: this.ledger.constructor.name };
  }
}

@WorkflowFinish({
  name: "studio-ledger-finish-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class StudioLedgerFinish {}

@Workflow({
  name: "studio-ledger-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(StudioLedgerStart).toAction(StudioLedgerAction).toFinish(StudioLedgerFinish)],
})
class StudioLedgerWorkflow {}

@DatabaseStorage({
  driver: SqliteDriver({ path: join(folder, "studio.sqlite") }),
  auditLogTtl: days(90),
  ledgerEntriesTtl: days(30),
})
class StudioDatabaseStorage {}

@Application({
  name: "studio-storage-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StudioLedgerWorkflow],
  budgets: TEST_BUDGETS,
  storage: StudioDatabaseStorage,
})
class StudioStorageApplication {}

describe("studioOf on an application with a SQLite storage", () => {
  it("draws the workflow whose components read the storage's connection", async () => {
    const studio = await studioOfWith(StudioStorageApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });
    try {
      const [name] = studio.names;
      expect(name).toBeDefined();
      const drawn = await studio.graph(name ?? "").getGraphAsync({ xray: true });
      expect(Object.keys(drawn.nodes).length).toBeGreaterThan(0);
    } finally {
      await studio.close();
    }
  });
});
