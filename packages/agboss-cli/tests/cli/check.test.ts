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
  piiKeyWarning,
  TEST_APPLICATION_REPORT,
} from "./agboss.js";

const BROKEN = fixture("cli/broken.workflow.ts");
const BAD_PROMPTS = fixture("cli/bad-prompts.workflow.ts");
const WORKFLOW = fixture("test-workflow/test.workflow.ts");
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
  it("a graph rule violation: file code message lines, exit 3, no API key", async () => {
    const call = await agboss(["check", "--application", BROKEN], CWD);

    expect(call.code).toBe(3);
    const lines = call.stdout.trimEnd().split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\S*broken\.workflow\.ts graph\.dead-end \S/),
        expect.stringMatching(/^\S*broken\.workflow\.ts graph\.unreachable-node \S/),
      ]),
    );
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
  });

  it("a sound workflow passes: ok line, exit 0", async () => {
    const call = await agboss(["check", "--application", WORKFLOW], CWD);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout).toBe(
      `types: .agboss/types.d.ts\n${TEST_APPLICATION_REPORT}${ledgerWarning(WORKFLOW)}${piiKeyWarning(WORKFLOW)}ok: ${WORKFLOW} — ${CHECKS_RUN}\n`,
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
      `${TYPO}:4 prompt.unknown-variable {{knownPlace}} — known: boards, boardCount`,
    ]);
    expect(call.stderr).toMatch(/^agboss check: 2 problem\(s\) in /);
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
      message: "{{knownPlace}} — known: boards, boardCount",
    });
  });

  it("a workflow whose prompts render passes with --prompts: exit 0", async () => {
    const call = await agboss(["check", "--prompts", "--application", WORKFLOW], CWD);

    expect(call).toMatchObject({
      code: 0,
      stdout: `types: .agboss/types.d.ts\n${TEST_APPLICATION_REPORT}${ledgerWarning(WORKFLOW)}${piiKeyWarning(WORKFLOW)}ok: ${WORKFLOW} — ${CHECKS_RUN}\n`,
    });
  });
});

describe("#261 AC14: the application's assembly warnings in agboss check", () => {
  it("printed without --strict (exit 0); errors under --strict (exit 3)", async () => {
    const warned = await agboss(["check", "--application", WORKFLOW], CWD);
    const strict = await agboss(["check", "--strict", "--application", WORKFLOW, "--json"], CWD);

    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain(ledgerWarning(WORKFLOW));
    expect(strict.code).toBe(3);
    expect((envelope(strict).result as CheckResult).problems).toContainEqual({
      file: WORKFLOW,
      code: "application.in-memory-cost-ledger",
      message:
        "in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart",
    });
  });

  it("#120 S94: no pseudonymKey — [application.pii-instance-key] printed, an error under --strict", async () => {
    const warned = await agboss(["check", "--application", WORKFLOW], CWD);
    const strict = await agboss(["check", "--strict", "--application", WORKFLOW, "--json"], CWD);

    expect(warned.stdout).toContain(piiKeyWarning(WORKFLOW));
    expect(strict.code).toBe(3);
    expect((envelope(strict).result as CheckResult).problems).toContainEqual(
      expect.objectContaining({ file: WORKFLOW, code: "application.pii-instance-key" }),
    );
  });
});
