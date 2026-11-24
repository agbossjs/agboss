import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../../src/check.js";
import {
  CHECKS_RUN,
  envelope,
  fixture,
  agboss,
  ledgerWarning,
  TEST_APPLICATION_REPORT,
} from "./agboss.js";

const BROKEN = fixture("cli/broken.workflow.ts");
const BAD_PROMPTS = fixture("cli/bad-prompts.workflow.ts");
const WORKFLOW = fixture("test-workflow/test.workflow.ts");
const NO_BREAKER = fixture("cli/no-breaker.application.ts");
const NULL_BREAKER = fixture("cli/null-breaker.application.ts");
/** A prompt file: reported by its path from the working directory. */
const TYPO = relative(process.cwd(), fixture("cli/typo.prompt.md"));

/** Where the checks run: `agboss check` writes the project's `.agboss/types.d.ts` there. */
const CWD = mkdtempSync(join(tmpdir(), "agboss-check-"));

interface CheckResult {
  readonly workflow: string;
  readonly checks: readonly string[];
  readonly problems: readonly { file: string; code: string; message: string }[];
}

describe("#198 AC3: agboss check runs every key-free validation", () => {
  it("a graph rule violation: a rustc-style snippet under the user's own line, exit 3, no API key", async () => {
    const call = await agboss(["check", "--application", BROKEN], CWD);

    expect(call.code).toBe(3);
    const lines = call.stdout.trimEnd().split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^error\[graph\.dead-end\]: \S/),
        expect.stringMatching(/^ +--> \S*broken\.workflow\.ts:\d+:\d+$/),
        expect.stringMatching(/^ +\| +\^+ `researcher-agent` breaks this rule$/),
        expect.stringMatching(/^error\[graph\.unreachable-node\]: \S/),
        "For more information about this error, try `agboss explain graph.dead-end`.",
      ]),
    );
    // the quoted line is the user's source, whole
    expect(call.stdout).toContain("|       .toAgent(Researcher),");
    expect(call.stderr).toMatch(/^agboss check: \d+ problem\(s\) in /);
  });

  it("--json: one envelope with every problem; ok false, exit 3", async () => {
    const call = await agboss(["check", "--application", BROKEN, "--json"], CWD);

    expect(call.code).toBe(3);
    const parsed = envelope(call);
    expect(parsed).toMatchObject({
      schema: 1,
      ok: false,
      command: "check",
      error: { code: "check.failed" },
    });
    const result = parsed.result as CheckResult;
    expect(result.checks).toEqual(["assembly", "environment", "application", "prompts", "types"]);
    expect(result.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(["graph.dead-end", "graph.unreachable-node"]),
    );
    expect(result.problems.every((p) => p.file === BROKEN)).toBe(true);
    // the snippet's places are for people: a problem of --json keeps its one shape
    expect(result.problems.every((p) => Object.keys(p).sort().join() === "code,file,message")).toBe(
      true,
    );
  });

  it("a sound workflow passes: ok line, exit 0", async () => {
    const call = await agboss(["check", "--application", WORKFLOW], CWD);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout).toBe(
      `types: .agboss/types.d.ts\n${TEST_APPLICATION_REPORT}${ledgerWarning(WORKFLOW)}ok: ${WORKFLOW} — ${CHECKS_RUN}\n`,
    );
  });

  it("checks needing the network run only with their flag (--models)", () => {
    expect(CHECKS.map((check) => [check.name, check.flag])).toEqual([
      ["environment", undefined],
      ["application", undefined],
      ["prompts", undefined],
      ["models", "models"],
      ["cassettes", "cassettes"],
      ["federation", "federation"],
    ]);
  });
});

describe("#199 + #198: the prompts check runs on every agboss check", () => {
  it("every prompt problem is one file[:line] code message line, exit 3, no API key", async () => {
    const call = await agboss(["check", "--application", BAD_PROMPTS], CWD);

    expect(call.code).toBe(3);
    expect(call.stdout.trimEnd().split("\n")).toEqual([
      "types: .agboss/types.d.ts",
      `${BAD_PROMPTS} prompt.unknown-variable @Router "main-router" prompt:2 {{bords}} — known: boards`,
      `${TYPO}:4 prompt.unknown-variable {{knownPlace}} — known: boards, boardCount, spare`,
      `${BAD_PROMPTS} prompt.unused-variable @Agent "scout-agent": promptVariables.spare is not used — no {{spare}} in its prompt`,
    ]);
    expect(call.stderr).toMatch(/^agboss check: 3 problem\(s\) in /);
  });

  it("--prompts is still accepted (prompts are always checked); --json carries the line", async () => {
    const call = await agboss(["check", "--prompts", "--application", BAD_PROMPTS, "--json"], CWD);

    expect(call.code).toBe(3);
    const result = envelope(call).result as CheckResult & {
      problems: readonly { line?: number }[];
    };
    expect(result.checks).toEqual(["assembly", "environment", "application", "prompts", "types"]);
    expect(result.problems[1]).toEqual({
      file: TYPO,
      line: 4,
      code: "prompt.unknown-variable",
      message: "{{knownPlace}} — known: boards, boardCount, spare",
    });
  });

  it("a workflow whose prompts render passes with --prompts: exit 0", async () => {
    const call = await agboss(["check", "--prompts", "--application", WORKFLOW], CWD);

    expect(call).toMatchObject({
      code: 0,
      stdout: `types: .agboss/types.d.ts\n${TEST_APPLICATION_REPORT}${ledgerWarning(WORKFLOW)}ok: ${WORKFLOW} — ${CHECKS_RUN}\n`,
    });
  });
});

describe("#261 AC14: the application's assembly warnings in agboss check", () => {
  it("printed without --strict (exit 0); errors under --strict (exit 3)", async () => {
    const warned = await agboss(["check", "--application", WORKFLOW], CWD);
    const strict = await agboss(["check", "--strict", "--application", WORKFLOW, "--json"], CWD);

    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain(ledgerWarning(WORKFLOW));
    // #1301b: the per-execution PII key warning is gone with the removed piiKeyField
    expect(warned.stdout).not.toContain("pii-instance-key");
    expect(strict.code).toBe(3);
    expect((envelope(strict).result as CheckResult).problems).toContainEqual({
      file: WORKFLOW,
      code: "application.in-memory-cost-ledger",
      message:
        "in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart",
    });
  });
});

/** The breaker is optional (#1313b): a provider without one is not a problem, only a provider that trips none. */
const breakerProblems = (call: Awaited<ReturnType<typeof agboss>>) =>
  (envelope(call).result as CheckResult).problems.filter(
    (problem) =>
      problem.code.includes("circuit-breaker") || problem.message.includes("circuitBreakerPolicy"),
  );

describe("#521 / #1313b: agboss check on a model provider without circuitBreakerPolicy", () => {
  it("no breaker problem is raised and nothing crashes: the breaker is optional", async () => {
    const call = await agboss(["check", "--application", NO_BREAKER, "--json"], CWD);

    expect(breakerProblems(call)).toEqual([]);
    expect(call.stderr).not.toMatch(/Cannot read properties/);
    // the provider is still checked: it is the unserved models that fail the run, not the missing breaker
    expect(call.code).toBe(3);
    expect((envelope(call).result as CheckResult).problems).toContainEqual(
      expect.objectContaining({ code: "model.unserved" }),
    );
  });
});

describe("#521 / #1313b acceptance: agboss check on circuitBreakerPolicy: null", () => {
  it("null is the same as none: no breaker problem, never a TypeError", async () => {
    const call = await agboss(["check", "--application", NULL_BREAKER, "--json"], CWD);

    expect(breakerProblems(call)).toEqual([]);
    expect(call.stderr).not.toMatch(/Cannot (read|destructure) propert/);
    expect(call.code).toBe(3);
  });
});
