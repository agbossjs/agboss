/**
 * #1324b (review 1426): the placeholder mode is check's and describe's alone, a tool or a service on
 * `deps: [appEnv]` is really built by them, a profile's `configureEnv` counts as set, and `rag index`
 * (a real run) fails on an unset variable and reads the profile's.
 */
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture, type AgbossCall } from "../cli/agboss.js";

const PING = new URL(
  "../../../agboss/tests/environments/fixtures/profile-env/profile-env.application.ts",
  import.meta.url,
).pathname;
const FUSSY = PING.replace("profile-env.application.ts", "fussy.application.ts");
const RAG = fixture("cli/env-rag/env-rag.application.ts");

const problemsOf = (call: AgbossCall): string =>
  JSON.stringify((envelope(call).result as { problems: unknown }).problems);

describe("check and describe build a tool on deps: [appEnv] with nothing set", () => {
  it("check exits 0 and describe exits 0 with no variable set", async () => {
    const check = await agboss(["check", "--application", PING, "--json"], process.cwd(), {});
    const described = await agboss(["describe", "--application", PING], process.cwd(), {});

    expect(problemsOf(check)).not.toContain("environment.");
    expect(check.code, check.stderr).toBe(0);
    expect(described.code, described.stderr).toBe(0);
    expect(described.stdout).toContain("ping-tool");
  });

  it("the report lists the variables the tool's deps name, the required one `not set`", async () => {
    const call = await agboss(["check", "--application", PING], process.cwd(), {});

    expect(call.stdout).toContain("PROFILE_ENV_REQUIRED  value, not set");
    // read with a default in one place and without in another: required wins
    expect(call.stdout).toContain("PROFILE_ENV_UPSTREAM  value, not set");
  });
});

describe("a component that cannot be built on a placeholder is a problem, not an internal error", () => {
  it("[environment.placeholder-failed] names the unset variable and carries no error text", async () => {
    const call = await agboss(["check", "--application", FUSSY, "--json"], process.cwd(), {});

    expect(call.code).toBe(3);
    expect(problemsOf(call)).toContain("[environment.placeholder-failed]");
    expect(problemsOf(call)).toContain("PROFILE_ENV_REQUIRED");
    expect(problemsOf(call)).not.toContain("Invalid URL");
  });

  it("with the variable set the same application checks clean", async () => {
    const call = await agboss(["check", "--application", FUSSY, "--json"], process.cwd(), {
      PROFILE_ENV_REQUIRED: "https://set.example",
    });

    expect(call.code, call.stdout).toBe(0);
  });
});

describe("--strict reads the profile's configureEnv and checks what is set", () => {
  it("an unset required variable is missing; a profile that gives it makes it set", async () => {
    const without = await agboss(
      ["check", "--application", PING, "--strict", "--json"],
      process.cwd(),
      {},
    );
    const staged = await agboss(
      ["check", "--application", PING, "--strict", "--profile", "staging", "--json"],
      process.cwd(),
      {},
    );

    expect(problemsOf(without)).toContain(
      "[environment.missing-variable] PROFILE_ENV_REQUIRED is not set",
    );
    expect(problemsOf(staged)).not.toContain("environment.missing-variable");
  });

  it("a set variable its reference cannot read is [environment.invalid-value], the value never printed", async () => {
    const call = await agboss(
      ["check", "--application", PING, "--strict", "--json"],
      process.cwd(),
      { PROFILE_ENV_REQUIRED: "x", PROFILE_ENV_RETRIES: "seven-secret" },
    );

    expect(problemsOf(call)).toContain(
      "[environment.invalid-value] PROFILE_ENV_RETRIES is not an integer",
    );
    expect(call.stdout + call.stderr).not.toContain("seven-secret");
  });
});

describe("rag index is a real run: strict variables, the profile's values", () => {
  it("an unset required variable fails with [environment.missing-variable], nothing is indexed", async () => {
    const call = await agboss(["rag", "index", "--application", RAG], process.cwd(), {});

    expect(call.code).not.toBe(0);
    expect(call.stderr + call.stdout).toContain(
      "[environment.missing-variable] ENV_RAG_DOCS is not set",
    );
    expect(call.stdout).not.toContain("env-rag:");
  });

  it("--profile staging gives it from configureEnv", async () => {
    const call = await agboss(
      ["rag", "index", "--application", RAG, "--profile", "staging"],
      process.cwd(),
      {},
    );

    expect(call.code, call.stderr).toBe(0);
    expect(call.stdout).toContain("env-rag: 12 documents");
  });

  it("the process's variable is used without a profile", async () => {
    const call = await agboss(["rag", "index", "--application", RAG], process.cwd(), {
      ENV_RAG_DOCS: "ab",
    });

    expect(call.code, call.stderr).toBe(0);
    expect(call.stdout).toContain("env-rag: 2 documents");
  });
});
