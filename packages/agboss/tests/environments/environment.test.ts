/**
 * #261 PR 4 (AC8): the environment contract is a class with declared fields only, declared once in
 * `@Application({ environment })`; each environment is `export const environment: AppEnvironment =
 * { … }` in `environments/<name>.environment.ts` next to the application file. Apps default to
 * `dev`, tests to `test` — and fail without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppOptions } from "../../src/app/create-app.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { EnvironmentFieldType, requireEnvironmentFields } from "../../src/environments/contract.js";
import { EnvironmentErrorCode, GraphRuleError, Injectable, env, secret } from "../../src/index.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import type { SettingsEnvironment } from "../fixtures/environments/app/environments/app.environment.js";
import {
  ApiClient,
  ApiSettings,
  ChatStart,
  Clerk,
  SettingsApp,
  SettingsApplication,
} from "../fixtures/environments/app/settings.workflow.js";
import { NoEnvironmentApplication } from "../fixtures/environments/none/no-environment.workflow.js";
import {
  ObservedApplication,
  RunLog,
} from "../fixtures/environments/observed/observed.workflow.js";
import { UntestedApplication } from "../fixtures/environments/untested/untested.workflow.js";
import { toolResultsOf } from "../testing/fixtures/requests.js";
import { execute } from "../helpers/flow.js";
import { EmptyEnvironment } from "../../src/index.js";

/** Everything external given; `processEnv` is what `env(…)` and `secret(…)` read. */
function offline(processEnv: NodeJS.ProcessEnv = {}): AppOptions {
  const book = new ScriptBook();
  return {
    processEnv,
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
  };
}

const TOKEN = { FIXTURE_API_TOKEN: "t0ken" };

/** The rule violations an application's assembly fails with. */
async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

describe("#261 AC8: no env named → dev.environment.ts next to the application file", () => {
  it("createApp gives its services the dev values: literals, defaults of env(), env.integer(), env.flag()", async () => {
    const app = await createApp(SettingsApplication, offline(TOKEN));
    const { apiUrl, currency, timeoutSeconds, debug } = app.resolve(ApiClient).environment;
    expect({ apiUrl, currency, timeoutSeconds, debug }).toEqual({
      apiUrl: "https://api.dev.example.com",
      currency: "USD",
      timeoutSeconds: 30,
      debug: false,
    });
    await app.close();
  });

  it("createApp(App, { env }) loads another file; a set variable is parsed by its field's type", async () => {
    const vars = { ...TOKEN, FIXTURE_CURRENCY: "ILS", FIXTURE_TIMEOUT: "5" };
    const app = await createApp(SettingsApplication, { ...offline(vars), env: "staging" });
    const { apiUrl, currency, timeoutSeconds } = app.resolve(ApiClient).environment;
    expect({ apiUrl, currency, timeoutSeconds }).toEqual({
      apiUrl: "https://api.staging.example.com",
      currency: "ILS",
      timeoutSeconds: 5,
    });
    await app.close();
  });

  it("the environment is frozen", async () => {
    const app = await createApp(SettingsApplication, offline(TOKEN));
    expect(Object.isFrozen(app.resolve(ApiClient).environment)).toBe(true);
    await app.close();
  });
});

describe("#261 AC9: a missing process variable fails the start naming it, the field and the environment", () => {
  it("every missing variable at once, never a value", async () => {
    await expect(createApp(SettingsApplication, { ...offline(), env: "staging" })).rejects.toThrow(
      "FIXTURE_API_TOKEN is not set (SettingsEnvironment.apiToken, staging); " +
        "FIXTURE_CURRENCY is not set (SettingsEnvironment.currency, staging); " +
        "FIXTURE_TIMEOUT is not set (SettingsEnvironment.timeoutSeconds, staging)",
    );
  });

  it("a value that is not of the field's type fails the start too", async () => {
    const vars = { ...TOKEN, FIXTURE_TIMEOUT: "soon", FIXTURE_DEBUG: "maybe" };
    await expect(createApp(SettingsApplication, offline(vars))).rejects.toMatchObject({
      code: EnvironmentErrorCode.InvalidValue,
      message:
        "FIXTURE_TIMEOUT is not an integer (SettingsEnvironment.timeoutSeconds, dev); " +
        "FIXTURE_DEBUG is not a flag (true, false, 1, 0) (SettingsEnvironment.debug, dev)",
    });
  });

  it("an unknown name fails at once, listing the environments (not the contract file)", async () => {
    await expect(createApp(SettingsApplication, { ...offline(), env: "nope" })).rejects.toThrow(
      /Environment "nope" not found: .*nope\.environment\.ts\. Available: dev, staging, test$/,
    );
  });

  it("naming the contract's file is not an environment", async () => {
    await expect(createApp(SettingsApplication, { ...offline(), env: "app" })).rejects.toThrow(
      /app\.environment\.ts holds the contract SettingsEnvironment, not an environment/,
    );
  });
});

describe("#261: an application without an environment contract", () => {
  it("#261 PR 3: a service reading applicationContext.environment gets an empty one", async () => {
    const app = await createApp(NoEnvironmentApplication, offline());

    const { applicationContext } = app.resolve(ApiClient);

    expect(applicationContext.environment).toEqual({});
    expect(applicationContext.environmentName).toBe("dev");
    await app.close();
  });

  it("#239: an observer taking ApplicationContext (no tool does) starts the same way", async () => {
    const app = await createApp(ObservedApplication, offline());

    expect(app.resolve(RunLog).applicationContext.name).toBe("observed-application");
    await app.close();
  });

  it("naming an environment fails: the application declares none", async () => {
    await expect(
      createApp(NoEnvironmentApplication, { ...offline(), env: "dev" }),
    ).rejects.toMatchObject({
      code: EnvironmentErrorCode.NoContract,
      message: expect.stringContaining(
        "no-environment-application declares no environment",
      ) as string,
    });
  });
});

describe("#261 AC8: tests default to the test environment", () => {
  beforeAll(() => {
    vi.stubEnv("FIXTURE_API_TOKEN", "test-t0ken");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const byDefault = testWith(SettingsApplication);
  const asDev = testWith(SettingsApplication, { env: "dev" });

  byDefault(
    "no option → test.environment.ts — the agent's tool sees it",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(ApiSettings, { what: "all" }), replyWith("done"));

      await execute(app, ChatStart, { text: "which API?" });

      expect(toolResultsOf(mockLlm(Clerk).lastRequest)).toEqual([
        JSON.stringify({ apiUrl: "https://api.test.example.com", currency: "EUR" }),
      ]);
    },
  );

  asDev("{ env } names another one", async ({ app }) => {
    expect(await app.tool(ApiSettings).invoke({ what: "all" })).toMatchObject({
      value: { apiUrl: "https://api.dev.example.com", currency: "USD" },
    });
  });

  it("no test.environment.ts → the test fails, saying to create it (never dev's values)", async () => {
    await expect(TestEnvironment.of(UntestedApplication)).rejects.toThrow(
      /Environment "test" not found: .*untested\/environments\/test\.environment\.ts — tests run on the test environment, never on dev's values: create it \(export const environment: SettingsEnvironment = \{ … \}\)/,
    );
  });

  it("testWith takes no environment values: one way, the environment files", () => {
    // @ts-expect-error — `environment` is not an option: name an environment with `env`
    expect(testWith(SettingsApplication, { environment: { apiUrl: "x" } })).toBeTypeOf("function");
  });
});

/** A contract with a value in a field: silently ignored by the environments, so an error. */
export class ValuedEnvironment {
  apiUrl!: string;
  region = "europe-west1";
}

@Application({
  name: "valued-application",
  version: "1.0.0",
  environment: ValuedEnvironment,
  workflows: [SettingsApp],
  budgets: TEST_BUDGETS,
})
class ValuedApplication {}

/** A framework implementation that reads a field of the project's contract. */
@Injectable()
class FilePausedExecutionRepository extends InMemoryPausedExecutionRepository {}
requireEnvironmentFields(FilePausedExecutionRepository, [
  { field: "sqlitePath", type: EnvironmentFieldType.Text },
  { field: "apiUrl", type: EnvironmentFieldType.Text },
]);

@Application({
  name: "ledger-application",
  version: "1.0.0",
  environment: ValuedEnvironment,
  workflows: [SettingsApp],
  providers: [FilePausedExecutionRepository],
  budgets: TEST_BUDGETS,
})
class LedgerApplication {}

// @ts-expect-error — environment is required (#261): an untyped caller without one is checked too
@Application({
  name: "contractless-application",
  version: "1.0.0",
  workflows: [SettingsApp],
  providers: [FilePausedExecutionRepository],
  budgets: TEST_BUDGETS,
})
class ContractlessApplication {}

@Application({
  name: "no-settings-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SettingsApp],
  budgets: TEST_BUDGETS,
})
class NoSettingsApplication {}

describe("#261 AC1: environment is required; an application with no settings declares an empty contract", () => {
  it("an @Application without environment does not compile (ContractlessApplication above)", () => {
    expect(ContractlessApplication).toBeTypeOf("function");
  });

  it("an empty contract needs no environment file: createApp's dev and testWith's test are {}", async () => {
    const app = await createApp(NoSettingsApplication, offline());
    expect(app.resolve(ApiClient).environment).toEqual({});
    await app.close();
    await expect(TestEnvironment.of(NoSettingsApplication)).resolves.toBeInstanceOf(
      TestEnvironment,
    );
  });

  it("an environment named for an empty contract still needs its file", async () => {
    await expect(createApp(NoSettingsApplication, { ...offline(), env: "prod" })).rejects.toThrow(
      /Environment "prod" not found/,
    );
  });
});

describe("#261 AC8: the contract's rules, at the application's assembly", () => {
  it("contract value: a field with a value → [environment.contract-value]", async () => {
    expect(await violationsOf(ValuedApplication)).toEqual([
      "[environment.contract-value] ValuedEnvironment.region has a value — the contract declares fields only; put the value in each environment",
    ]);
  });

  it("missing field names it: a listed implementation's field missing from the contract", async () => {
    expect(await violationsOf(LedgerApplication)).toContain(
      "[environment.missing-field] FilePausedExecutionRepository needs sqlitePath: string in ValuedEnvironment",
    );
    expect(await violationsOf(LedgerApplication)).not.toContainEqual(
      expect.stringContaining("needs apiUrl"),
    );
  });

  it("missing field without a contract names the fix", async () => {
    expect(await violationsOf(ContractlessApplication)).toEqual([
      "[environment.missing-field] FilePausedExecutionRepository needs sqlitePath: string in the environment contract — declare one: @Application({ environment: AppEnvironment })",
      "[environment.missing-field] FilePausedExecutionRepository needs apiUrl: string in the environment contract — declare one: @Application({ environment: AppEnvironment })",
    ]);
  });
});

describe("#261 AC8: an environment is a typed object literal", () => {
  it("a missing field, a mistyped one or a field the contract lacks does not compile", () => {
    // @ts-expect-error — `debug` is missing: the contract requires it
    const missing: SettingsEnvironment = {
      apiUrl: "https://x",
      apiToken: secret("TOKEN"),
      currency: "USD",
      timeoutSeconds: 1,
    };
    const mistyped: SettingsEnvironment = {
      apiUrl: "https://x",
      apiToken: secret("TOKEN"),
      currency: "USD",
      // @ts-expect-error — `timeoutSeconds` is a number: env.integer(…), not env(…)
      timeoutSeconds: env("TIMEOUT"),
      debug: false,
    };
    const extra: SettingsEnvironment = {
      apiUrl: "https://x",
      apiToken: secret("TOKEN"),
      currency: "USD",
      timeoutSeconds: 1,
      debug: env.flag("DEBUG"),
      // @ts-expect-error — a field the contract does not have
      region: "eu",
    };
    expect([missing, mistyped, extra]).toHaveLength(3);
  });
});
