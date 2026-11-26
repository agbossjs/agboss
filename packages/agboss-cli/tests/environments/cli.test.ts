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

describe("#1324b: agboss check's report and strict mode never carry a value", () => {
  const NEEDS = fixture("cli/env-needs.application.ts");
  const SET = {
    ENV_NEEDS_URL: "https://needs.example",
    ENV_NEEDS_KEY: "needs-secret-value",
  };

  it("--json lists the variables by name with use and presence, no value", async () => {
    const call = await agboss(["check", "--application", NEEDS, "--json"], process.cwd(), SET);

    expect(call.code, call.stderr).toBe(0);
    const text = JSON.stringify(envelope(call));
    expect(text).toContain('"variable":"ENV_NEEDS_KEY"');
    expect(text).toContain('"use":"secret"');
    expect(text).not.toContain("needs-secret-value");
    expect(text).not.toContain("https://needs.example");
  });

  it("--strict with every variable set reports no missing variable and prints no value", async () => {
    const call = await agboss(
      ["check", "--application", NEEDS, "--strict", "--json"],
      process.cwd(),
      SET,
    );

    // the in-memory ledger warning is an error under --strict; the variables are not a problem
    expect(JSON.stringify(envelope(call).result)).not.toContain("environment.missing-variable");
    expect(call.stdout + call.stderr).not.toContain("needs-secret-value");
    expect(call.stdout + call.stderr).not.toContain("https://needs.example");
  });

  it("--strict --models fails on the unset secret too, naming the variable, never a value", async () => {
    const call = await agboss(
      ["check", "--application", NEEDS, "--strict", "--models", "--json"],
      process.cwd(),
      { ENV_NEEDS_URL: "https://needs.example" },
    );

    expect(call.code).toBe(3);
    const text = JSON.stringify(envelope(call).result);
    expect(text).toContain("[environment.missing-variable] ENV_NEEDS_KEY is not set");
    expect(text).not.toContain("https://needs.example");
  });

  it("describe, text and JSON, prints no secret value", async () => {
    for (const argv of [[], ["--json"]]) {
      const call = await agboss(["describe", "--application", NEEDS, ...argv], process.cwd(), SET);

      expect(call.code, call.stderr).toBe(0);
      expect(call.stdout + call.stderr).not.toContain("needs-secret-value");
    }
  });
});

describe("#1324b: every profile of src/config/ is checked schema-only, the inactive ones too", () => {
  const TS_APP = new URL(
    "../../../agboss/tests/config/fixtures/ts-app/ts.application.ts",
    import.meta.url,
  ).pathname;

  it("a bad inactive profile is a profile.invalid problem naming its file; the value it carries is never printed", async () => {
    const call = await agboss(["check", "--application", TS_APP, "--json"], process.cwd(), {});

    const problems = JSON.stringify(envelope(call).result);
    expect(call.code).toBe(3);
    expect(problems).toContain("typo.config.ts");
    expect(problems).toContain("wrong-value.config.ts");
    expect(problems).toContain('"code":"profile.invalid"');
    expect(call.stdout + call.stderr).not.toContain("hot-secret-value");
  });

  it("no variable has to be set for it: the variables of its defineEnv are listed, not read", async () => {
    const call = await agboss(["check", "--application", TS_APP], process.cwd(), {});

    expect(call.stdout).toContain("the application needs 3 process variables:");
    expect(call.stdout).toContain("TS_APP_API_KEY");
  });
});
