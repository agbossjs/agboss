/**
 * #1343 (#1321): readiness pings each storage component once — the stores a component's driver
 * creates share its connection, so one ping reaches it for all and the report names the component
 * (`@DatabaseStorage`'s name), not each repository. A checkpoint saver with no `ping()` is not probed
 * (no thread is read to find out).
 */
import { describe, expect } from "vitest";
import {
  Application,
  EmptyEnvironment,
  HealthComponentKind,
  HealthStatus,
} from "../../src/index.js";
import { temporaryFileDatabaseStorage } from "../../src/storage/in-memory-storage.js";
import { testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { workflowWith } from "../core/observers/fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const Storage = temporaryFileDatabaseStorage();

@Application({
  name: "storage-health-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [workflowWith("storage-health-workflow")],
  budgets: TEST_BUDGETS,
  storage: Storage,
})
class StorageHealthApplication {}

const test = testWith(StorageHealthApplication);

describe("#1321: one ping per storage component", () => {
  test("the stores of one storage component are one component in the report, under its name", async ({
    app,
  }) => {
    const report = await app.checkReadiness();

    const storage = report.components.filter(({ kind }) => kind === HealthComponentKind.Storage);
    expect(report.status).toBe(HealthStatus.Healthy);
    // every repository its driver creates, and its checkpoint saver, are reached by that one ping
    expect(storage.map(({ name }) => name)).toEqual(["temporary-file-database-storage"]);
  });
});
