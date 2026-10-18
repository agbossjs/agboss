/**
 * #265 AC3: every storage contract defaults to in-memory; a SQLite implementation is enabled only
 * by listing it; `sqlitePath` is required only then, and a missing one fails — at assembly when
 * the contract lacks the field, at start when its value is empty — naming it.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { Class } from "../../../src/components/injection.js";
import {
  EmptyEnvironment,
  GraphRuleError,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../src/index.js";
import { createApp } from "../../../src/application/create-app.js";
import { McpStubs, stubbedMcpConnect } from "../../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { INFRASTRUCTURE_DEFAULTS } from "../../../src/infrastructure/contracts.js";
import { isSqliteImplementation } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecoveryWorkflow } from "../fixtures/recovery.workflow.js";
import { connectionTo } from "../contracts/store-kinds.js";

const ALL_SQLITE = [
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
];

/** Lists every SQLite implementation, but its contract has no `sqlitePath`. */
@Application({
  name: "pathless-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  providers: ALL_SQLITE,
  budgets: TEST_BUDGETS,
})
class PathlessApplication {}

/** Lists none: no `sqlitePath` needed, every contract in memory. */
@Application({
  name: "in-memory-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  budgets: TEST_BUDGETS,
})
class InMemoryApplication {}

async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) return [];
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

describe("#265 AC3: sqlitePath is required only when a SQLite implementation is listed", () => {
  it("required only when listed, missing names it: one violation per listed implementation", async () => {
    const violations = await violationsOf(PathlessApplication);

    expect(violations).toEqual(
      ALL_SQLITE.map(
        (implementation) =>
          `[environment.missing-field] ${implementation.name} needs sqlitePath: string in EmptyEnvironment`,
      ),
    );
    expect(await violationsOf(InMemoryApplication)).toEqual([]);
  });

  it("listed none: every contract is the built-in in-memory default", async () => {
    const book = new ScriptBook();
    const app = await createApp(InMemoryApplication, {
      gateway: createScriptedGateway(book),
      connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
    });

    const used = [...INFRASTRUCTURE_DEFAULTS.keys()].map((contract) => app.resolve(contract));

    expect(used.map((instance) => (instance as object).constructor)).toEqual([
      ...INFRASTRUCTURE_DEFAULTS.values(),
    ]);
    expect(used.some((instance) => isSqliteImplementation(instance as object))).toBe(false);
    await app.close();
  });

  it("an empty sqlitePath fails at start, naming it", () => {
    expect(() => connectionTo("")).toThrow(/sqlitePath/);
  });
});
