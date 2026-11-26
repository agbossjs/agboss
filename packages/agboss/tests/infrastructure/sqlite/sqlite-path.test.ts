/**
 * #265 AC3, #1324b: every storage contract defaults to in-memory; a SQLite implementation is
 * enabled only by the application's `@DatabaseStorage({ driver: SqliteDriver({ path }) })`: its
 * path is the file, and with no such storage — or an empty path — the start fails naming it.
 */
import { createTestAppWith } from "../../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../../src/application/application.js";
import {
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../src/index.js";
import { SqliteCheckpointSaver } from "../../../src/internal.js";
import { McpStubs, stubbedMcpConnect } from "../../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { CheckedIdGenerator } from "../../../src/infrastructure/clock.js";
import { INFRASTRUCTURE_DEFAULTS } from "../../../src/infrastructure/contracts.js";
import { isSqliteImplementation } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecoveryWorkflow } from "../fixtures/recovery.workflow.js";
import { connectionTo } from "../contracts/store-kinds.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

const ALL_SQLITE = [
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
];

/** Lists every SQLite implementation, but declares no database storage: no file to open. */
@Application({
  name: "pathless-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [RecoveryWorkflow],
  providers: ALL_SQLITE,
  budgets: TEST_BUDGETS,
})
class PathlessApplication {}

/** Lists none: no file needed, every contract in memory. */
@Application({
  name: "in-memory-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [RecoveryWorkflow],
  budgets: TEST_BUDGETS,
})
class InMemoryApplication {}

describe("#265 AC3: the SQLite file is the storage's, required only when a SQLite implementation is listed", () => {
  it("listed without a database storage: the start fails naming the storage to declare", async () => {
    const book = new ScriptBook();

    await expect(
      createTestAppWith(PathlessApplication, {
        gateway: createScriptedGateway(book),
        connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
      }),
    ).rejects.toThrow(
      /need the application's @DatabaseStorage\(\{ driver: SqliteDriver\(\{ path \}\) \}\)/,
    );
  });

  it("listed none: every contract is the built-in in-memory default", async () => {
    const book = new ScriptBook();
    const app = await createTestAppWith(InMemoryApplication, {
      gateway: createScriptedGateway(book),
      connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
    });

    // the framework mints through the checked generator over the default (#578)
    const used = [...INFRASTRUCTURE_DEFAULTS.keys()]
      .map((contract) => app.resolve(contract))
      .map((instance) => (instance instanceof CheckedIdGenerator ? instance.minting : instance));

    // the Logger is the masking wrapper (#1301b), which binds every member, `constructor` too:
    // `bound ConsoleLogger` is the default's own class by name
    const unbound = (name: string): string => name.replace(/^bound /, "");
    expect(used.map((instance) => unbound((instance as object).constructor.name))).toEqual(
      [...INFRASTRUCTURE_DEFAULTS.values()].map((implementation) => implementation.name),
    );
    expect(used.some((instance) => isSqliteImplementation(instance as object))).toBe(false);
    await app.close();
  });

  it("an empty path fails at start, naming it", () => {
    expect(() => connectionTo("")).toThrow(/SqliteDriver's path/);
  });
});
