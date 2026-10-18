import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { type AppOptions } from "../../src/app/create-app.js";
import { createApp } from "../../src/application/create-app.js";
import { createMemoryLedger } from "../../src/finops/ledger.js";
import { defineEnvironment, fromEnv } from "../../src/index.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ApiClient,
  ApiSettings,
  ChatStart,
  Clerk,
  SettingsApplication,
} from "../fixtures/environments/app/settings.workflow.js";
import { NoEnvironmentApplication } from "../fixtures/environments/none/no-environment.workflow.js";
import { ObservedApplication } from "../fixtures/environments/observed/observed.workflow.js";
import { toolResultsOf } from "../testing/fixtures/requests.js";
import { execute } from "../helpers/flow.js";

/** Everything external given; `processEnv` is what `fromEnv` reads. */
function offline(processEnv: NodeJS.ProcessEnv = {}): AppOptions {
  const book = new ScriptBook();
  return {
    processEnv,
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
  };
}

const STUB = { apiUrl: "http://stub.local", apiKey: "test-key", currency: "EUR" };

describe("#182 AC1: no env named → dev.environment.ts next to the workflow file", () => {
  it("createApp(W) gives its services the dev values: literals, and fromEnv defaults", async () => {
    const app = await createApp(SettingsApplication, offline());
    expect(app.resolve(ApiClient).env).toEqual({
      apiUrl: "https://api.dev.example.com",
      apiKey: "dev-key",
      currency: "USD",
    });
    await app.close();
  });

  it("createApp(W, { env }) loads another file; a set variable wins over the default", async () => {
    const vars = { FIXTURE_API_KEY: "s3cret", FIXTURE_CURRENCY: "ILS" };
    const app = await createApp(SettingsApplication, { ...offline(vars), env: "staging" });
    expect(app.resolve(ApiClient).env).toEqual({
      apiUrl: "https://api.staging.example.com",
      apiKey: "s3cret",
      currency: "ILS",
    });
    await app.close();
  });
});

describe("#182 AC3: fromEnv is resolved at start", () => {
  it("a missing required variable fails the start naming every missing one", async () => {
    await expect(createApp(SettingsApplication, { ...offline(), env: "staging" })).rejects.toThrow(
      'Environment "staging": missing variables FIXTURE_API_KEY, FIXTURE_CURRENCY',
    );
    await expect(
      createApp(SettingsApplication, { ...offline({ FIXTURE_CURRENCY: "ILS" }), env: "staging" }),
    ).rejects.toThrow(/missing variables FIXTURE_API_KEY$/);
  });

  it("an unknown name fails at once, listing the available environments", async () => {
    await expect(createApp(SettingsApplication, { ...offline(), env: "nope" })).rejects.toThrow(
      /Environment "nope" not found: .*nope\.environment\.ts\. Available: dev, staging/,
    );
  });

  it("a secret is the real value for the service, masked wherever it is printed", async () => {
    const app = await createApp(SettingsApplication, offline({ FIXTURE_API_KEY: "s3cret" }));
    const env = app.resolve(ApiClient).env;
    expect(env.apiKey).toBe("s3cret");
    expect(JSON.stringify(env)).toBe(
      '{"apiUrl":"https://api.dev.example.com","apiKey":"***","currency":"USD"}',
    );
    expect(inspect(env)).not.toContain("s3cret");
    await app.close();
  });
});

describe("#182 AC6: ENV injected with no environment → [di.missing-environment] at start", () => {
  it("the app does not start and names the service that injects ENV", async () => {
    await expect(createApp(NoEnvironmentApplication, offline())).rejects.toThrow(
      /^\[di\.missing-environment\] ApiClient injects ENV, but the app has no environment/,
    );
  });

  it("#239: an observer injecting ENV (no tool does) fails the start the same way", async () => {
    await expect(createApp(ObservedApplication, offline())).rejects.toThrow(
      /^\[di\.missing-environment\] RunLog injects ENV, but the app has no environment/,
    );
  });

  it("naming an environment without an environments/ folder fails as not found", async () => {
    await expect(createApp(NoEnvironmentApplication, { ...offline(), env: "dev" })).rejects.toThrow(
      /Environment "dev" not found: .*Available: none/,
    );
  });
});

const withValues = testWith(SettingsApplication, { environment: STUB });
const byDefault = testWith(SettingsApplication);

describe("#182 AC4: a test gives its own environment; the service receives it", () => {
  withValues(
    "testWith(W, { environment }) — the agent's tool sees it",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(ApiSettings, { what: "all" }), replyWith("done"));

      await execute(app, ChatStart, { text: "which API?" });

      expect(toolResultsOf(mockLlm(Clerk).lastRequest)).toEqual([JSON.stringify(STUB)]);
    },
  );

  withValues("app.tool(X) uses the same values", async ({ app }) => {
    expect(await app.tool(ApiSettings).invoke({ what: "all" })).toEqual({
      kind: "ok",
      value: STUB,
    });
  });
});

describe("#182: testWith picks an environment by the same rules as createApp", () => {
  byDefault("no option → dev.environment.ts", async ({ app }) => {
    expect(await app.tool(ApiSettings).invoke({ what: "all" })).toMatchObject({
      value: { apiUrl: "https://api.dev.example.com", currency: "USD" },
    });
  });

  it("{ env } with a missing variable fails before the test runs", async () => {
    await expect(TestEnvironment.of(SettingsApplication, { env: "staging" })).rejects.toThrow(
      /missing variables FIXTURE_API_KEY, FIXTURE_CURRENCY/,
    );
  });
});

describe("#182 AC5: an environment file is checked against the contract by tsc", () => {
  it("a missing or mistyped field does not compile", () => {
    // @ts-expect-error — `currency` is missing: the contract requires it
    const missing = defineEnvironment({ apiUrl: "https://x", apiKey: fromEnv("KEY") });
    // @ts-expect-error — `apiUrl` is a string in the contract
    const mistyped = defineEnvironment({ apiUrl: 42, apiKey: "k", currency: "USD" });
    // @ts-expect-error — a field the contract does not have
    const extra = defineEnvironment({ ...STUB, region: "eu" });
    expect([missing, mistyped, extra]).toHaveLength(3);
  });

  it("testWith's environment is typed by the contract too", () => {
    // @ts-expect-error — `apiKey` and `currency` are missing
    expect(testWith(SettingsApplication, { environment: { apiUrl: "x" } })).toBeTypeOf("function");
  });
});
