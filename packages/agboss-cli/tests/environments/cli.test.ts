import { describe, expect, it } from "vitest";
import { envelope, fixture, agboss } from "../cli/agboss.js";

const APP = fixture("environments/app/settings.workflow.ts");
const NONE = fixture("environments/none/no-environment.workflow.ts");
const OBSERVED = fixture("environments/observed/observed.workflow.ts");
const TOKEN = { FIXTURE_API_TOKEN: "t0ken" };

describe("#182 AC2: --env <name> on every workflow command", () => {
  it("an unknown name fails at once with exit 3, listing the available environments", async () => {
    const call = await agboss(["run", "--workflow", APP, "--env", "nope", "hello"]);
    expect(call.code).toBe(3);
    expect(call.stdout).toBe("");
    expect(call.stderr).toMatch(
      /Environment "nope" not found: .*nope\.environment\.ts\. Available: dev, staging, test/,
    );
    const json = await agboss(["describe", "--workflow", APP, "--env", "nope", "--json"]);
    expect(json.code).toBe(3);
    expect(envelope(json)).toMatchObject({ error: { code: "environment.not-found" } });
  });

  it("every workflow command takes --env", async () => {
    const commands = ["chat", "run", "describe", "check", "eval", "replay", "golden", "compare"];
    for (const command of [...commands, "rag:index"]) {
      const one = envelope(await agboss(["help", command, "--json"]));
      expect(JSON.stringify(one.result)).toContain('"flag":"--env"');
    }
  });
});

describe("#182: agboss check validates the selected environment without running anything", () => {
  it("no --env → dev resolves (defaults, the secret set) → ok", async () => {
    const call = await agboss(["check", "--workflow", APP], process.cwd(), TOKEN);
    expect(call.code).toBe(0);
    expect(call.stdout).toContain("assembly, environment");
  });

  it("missing variables are a problem naming each of them (exit 3)", async () => {
    const call = await agboss(["check", "--workflow", APP, "--env", "staging", "--json"]);
    expect(call.code).toBe(3);
    expect(envelope(call).result).toMatchObject({
      problems: [
        {
          code: "environment.missing-variables",
          message:
            "FIXTURE_API_TOKEN is not set (SettingsEnvironment.apiToken, staging); " +
            "FIXTURE_CURRENCY is not set (SettingsEnvironment.currency, staging); " +
            "FIXTURE_TIMEOUT is not set (SettingsEnvironment.timeoutSeconds, staging)",
        },
      ],
    });
  });

  it("#261 AC9: --env lists the process variables it needs, marked value / secret", async () => {
    const call = await agboss(["check", "--workflow", APP, "--env", "dev"], process.cwd(), TOKEN);
    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "environment dev: process variables",
        "  FIXTURE_API_TOKEN  secret → apiToken",
        "  FIXTURE_CURRENCY  value (has a default) → currency",
        "  FIXTURE_TIMEOUT  value (has a default) → timeoutSeconds",
        "  FIXTURE_DEBUG  value (has a default) → debug",
      ].join("\n"),
    );
    expect(call.stdout).not.toContain("t0ken");
  });

  it("a service injecting ENV in an application without an environment is [di.missing-environment]", async () => {
    const call = await agboss(["check", "--workflow", NONE, "--json"]);
    expect(call.code).toBe(3);
    expect(envelope(call).result).toMatchObject({ problems: [{ code: "di.missing-environment" }] });
  });
});

describe("#239: agboss check creates what the app's start creates", () => {
  it("an observer injecting ENV, no environment → [di.missing-environment], as createApp", async () => {
    const call = await agboss(["check", "--workflow", OBSERVED, "--json"]);
    expect(call.code).toBe(3);
    expect(envelope(call).result).toMatchObject({
      checks: ["assembly", "environment", "prompts", "types"],
      problems: [
        {
          code: "di.missing-environment",
          message: expect.stringMatching(
            /^\[di\.missing-environment\] RunLog injects ENV, but the application declares no environment/,
          ) as string,
        },
      ],
    });
  });
});

describe("#182: agboss describe shows the environment with secrets masked", () => {
  it("the dev environment: literals, defaults, a secret as *** — never its value", async () => {
    const call = await agboss(["describe", "--workflow", APP], process.cwd(), TOKEN);
    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "environment dev",
        '  apiUrl = "https://api.dev.example.com"',
        "  apiToken = *** (FIXTURE_API_TOKEN)",
        '  currency = "USD"',
        "  timeoutSeconds = 30",
        "  debug = false",
      ].join("\n"),
    );
    expect(call.stdout).not.toContain("t0ken");
  });

  it("a missing variable is shown, not fatal (describe needs no keys)", async () => {
    const call = await agboss(["describe", "--workflow", APP, "--env", "staging", "--json"]);
    expect(call.code).toBe(0);
    expect(envelope(call).result).toMatchObject({
      environment: {
        name: "staging",
        fields: {
          apiToken: "<missing FIXTURE_API_TOKEN>",
          currency: "<missing FIXTURE_CURRENCY>",
        },
      },
    });
  });
});
