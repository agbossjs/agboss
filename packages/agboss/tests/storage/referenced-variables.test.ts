/**
 * #1324: every process variable a component reads through `defineEnv` is named by `agboss check`:
 * the storage's file and secrets, listed once each, never a value.
 */
import { describe, expect, it } from "vitest";
import { referencedVariablesOf } from "../../src/application/referenced-variables.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { DatabaseStorage, SqliteDriver } from "../../src/storage/index.js";
import { defineEnv, env, secret } from "../../src/environments/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { NoteWorkflow } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const keys = defineEnv({
  path: env("REF_TEST_SQLITE_PATH", { default: "app.sqlite" }),
  idempotency: secret("REF_TEST_IDEMPOTENCY"),
  pii: secret("REF_TEST_PII"),
  optionalKey: secret.optional("REF_TEST_PREVIOUS"),
});

@DatabaseStorage({
  driver: SqliteDriver({ path: keys.path }),
  auditLogTtl: hours(1),
  ledgerEntriesTtl: hours(1),
  idempotencySecret: keys.idempotency,
  piiSecret: keys.pii,
  previousPiiSecret: keys.optionalKey,
})
class KeyedStorage {}

@Application({
  name: "referenced-variables-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [NoteWorkflow],
  budgets: TEST_BUDGETS,
  storage: KeyedStorage,
})
class KeyedApplication {}

describe("#1324: the variables an application's components read through defineEnv", () => {
  it("names the storage's file and secrets once each, by variable, with how each is needed", async () => {
    const found = referencedVariablesOf(await applicationOf(KeyedApplication));

    expect(
      found.map(({ variable, use, required, optional }) => [variable, use, required, optional]),
    ).toEqual([
      ["REF_TEST_SQLITE_PATH", "value", false, false],
      ["REF_TEST_IDEMPOTENCY", "secret", true, false],
      ["REF_TEST_PII", "secret", true, false],
      ["REF_TEST_PREVIOUS", "secret", false, true],
    ]);
  });
});
