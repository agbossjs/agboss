/**
 * #261 PR 4 (AC9): a secret is a `Secret` field set only with `secret("X")` from a process variable;
 * it prints as `***` everywhere — logs, JSON (traces), errors, `agboss describe` — and only
 * `.reveal()` gives the value.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import {
  describedEnvironment,
  environmentVariablesOf,
  VariableUse,
} from "../../src/environments/resolve.js";
import { EnvironmentError, Secret, env, secret } from "../../src/index.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { SettingsEnvironment } from "../fixtures/environments/app/environments/app.environment.js";
import { environment as staging } from "../fixtures/environments/app/environments/staging.environment.js";
import { ApiClient, SettingsApplication } from "../fixtures/environments/app/settings.workflow.js";

const VALUE = "s3cret-value";

async function resolvedToken(): Promise<Secret> {
  const book = new ScriptBook();
  const app = await createApp(SettingsApplication, {
    processEnv: { FIXTURE_API_TOKEN: VALUE },
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
  });
  const { apiToken } = app.resolve(ApiClient).environment;
  await app.close();
  return apiToken;
}

describe("#261 AC9: *** everywhere, reveal()", () => {
  it("reveal() gives the value of the process variable", async () => {
    expect((await resolvedToken()).reveal()).toBe(VALUE);
  });

  it("prints as *** in strings, logs, JSON and error messages", async () => {
    const token = await resolvedToken();
    expect(String(token)).toBe("***");
    expect(`Bearer ${String(token)}`).toBe("Bearer ***");
    expect(inspect({ token })).toBe("{ token: *** }");
    expect(JSON.stringify({ token })).toBe('{"token":"***"}');
    expect(new Error(`failed with ${String(token)}`).message).not.toContain(VALUE);
  });

  it("the whole environment prints without the value", async () => {
    const book = new ScriptBook();
    const app = await createApp(SettingsApplication, {
      processEnv: { FIXTURE_API_TOKEN: VALUE },
      gateway: createScriptedGateway(book),
      connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
    });
    const { environment } = app.resolve(ApiClient);
    expect(JSON.stringify(environment)).not.toContain(VALUE);
    expect(inspect(environment)).not.toContain(VALUE);
    await app.close();
  });

  it("a secret of an environment file is not resolved: reveal() names where to read it", () => {
    expect(() => staging.apiToken.reveal()).toThrow(EnvironmentError);
    expect(() => secret("X").reveal()).toThrow(
      /not resolved: read it from the application's environment/,
    );
  });

  it("agboss describe: *** with the variable, or what is missing — never the value", () => {
    const loaded = { name: "staging", contract: "SettingsEnvironment", values: staging };
    const shown = describedEnvironment(loaded, { FIXTURE_API_TOKEN: VALUE, FIXTURE_TIMEOUT: "9" });
    expect(shown.fields).toEqual({
      apiUrl: '"https://api.staging.example.com"',
      apiToken: "*** (FIXTURE_API_TOKEN)",
      currency: "<missing FIXTURE_CURRENCY>",
      timeoutSeconds: "9",
      debug: "false",
    });
    expect(describedEnvironment(loaded, {}).fields.apiToken).toBe("<missing FIXTURE_API_TOKEN>");
  });

  it("agboss check --env lists the process variables, marked value / secret", () => {
    const loaded = { name: "staging", contract: "SettingsEnvironment", values: staging };
    expect(environmentVariablesOf(loaded)).toEqual([
      { variable: "FIXTURE_API_TOKEN", field: "apiToken", use: VariableUse.Secret, required: true },
      { variable: "FIXTURE_CURRENCY", field: "currency", use: VariableUse.Value, required: true },
      {
        variable: "FIXTURE_TIMEOUT",
        field: "timeoutSeconds",
        use: VariableUse.Value,
        required: true,
      },
    ]);
  });

  it("a literal in a Secret field does not compile, nor a Secret where a string is expected", () => {
    const literal: Pick<SettingsEnvironment, "apiToken"> = {
      // @ts-expect-error — a secret comes only from a process variable: secret("X")
      apiToken: "hardcoded",
    };
    const fromEnv: Pick<SettingsEnvironment, "apiToken"> = {
      // @ts-expect-error — env("X") is a string; a Secret field takes secret("X")
      apiToken: env("TOKEN"),
    };
    // @ts-expect-error — a Secret is not a string: reveal() it where the value is used
    const asText: string = secret("TOKEN");
    expect([literal, fromEnv, asText]).toHaveLength(3);
  });
});
