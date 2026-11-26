import { describe, expect, it } from "vitest";
import { envelope, fixture, agboss } from "../cli/agboss.js";

const APP = fixture("test-workflow/test.workflow.ts");

describe("#1324b: the profile selects the configuration; no command takes --env", () => {
  it("--env is no option of any workflow command: a usage error, exit 2", async () => {
    for (const command of ["describe", "check"]) {
      const call = await agboss([command, "--application", APP, "--env", "dev"]);

      expect(call.code, command).toBe(2);
      expect(call.stdout).toBe("");
      expect(call.stderr).toContain("--env");
    }
  });

  it("every workflow command takes --profile, and none lists --env", async () => {
    const commands = ["chat", "run", "describe", "check", "eval", "studio", "dev", "rag"];
    for (const command of commands) {
      const help = JSON.stringify(envelope(await agboss(["help", command, "--json"])).result);

      expect(help, command).toContain('"flag":"--profile"');
      expect(help, command).not.toContain('"flag":"--env"');
    }
  });

  it("describe --json carries no environment: the values are the application's defineEnv, not a file", async () => {
    const call = await agboss(["describe", "--application", APP, "--json"]);

    expect(call.code).toBe(0);
    expect(JSON.stringify(envelope(call).result)).not.toContain('"environment"');
  });

  it("an unknown profile fails at once with exit 3, listing the ones that exist", async () => {
    const call = await agboss(["check", "--application", APP, "--profile", "nope", "--json"]);

    expect(call.code).toBe(3);
    expect(JSON.stringify(envelope(call))).toContain("nope");
  });
});

describe("#1324b, #266: check and describe need no variable's value", () => {
  const NEEDS = fixture("cli/env-needs.application.ts");

  it("an unset secret behind deps: [appEnv] is no failure: exit 0, the report names what is not set", async () => {
    const call = await agboss(["check", "--application", NEEDS], process.cwd(), {});

    expect(call.code, call.stderr).toBe(0);
    expect(call.stdout).toContain("ENV_NEEDS_URL  value, not set");
    expect(call.stdout).toContain("ENV_NEEDS_KEY  secret, not set");
  });

  it("describe builds the tools without the secret too", async () => {
    const call = await agboss(["describe", "--application", NEEDS], process.cwd(), {});

    expect(call.code, call.stderr).toBe(0);
  });

  it("--strict fails on the unset value, naming it; the secret only with --models", async () => {
    const call = await agboss(
      ["check", "--application", NEEDS, "--strict", "--json"],
      process.cwd(),
      {},
    );

    expect(call.code).toBe(3);
    const problems = JSON.stringify(envelope(call).result);
    expect(problems).toContain("[environment.missing-variable] ENV_NEEDS_URL is not set");
    expect(problems).not.toContain("ENV_NEEDS_KEY is not set");
  });

  it("with every variable set nothing is `not set`, and no value is printed", async () => {
    const call = await agboss(["check", "--application", NEEDS], process.cwd(), {
      ENV_NEEDS_URL: "https://needs.example",
      ENV_NEEDS_KEY: "needs-secret-value",
    });

    expect(call.code, call.stderr + call.stdout).toBe(0);
    expect(call.stdout).not.toContain("needs-secret-value");
    expect(call.stdout).not.toContain("not set");
  });
});
