/**
 * #397 PR 1 — the HTML report from the CLI: `agboss eval run … --html <file>` after a run, and
 * `agboss eval show <run.json> [--html <file>]` from a saved artifact — no application loaded,
 * nothing run; the artifact checked before anything renders; the page's size bound.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckStatus } from "agboss/eval";
import { artifactOf, caseOf, REFUNDS_ARTIFACT } from "../eval-html/artifacts.js";
import { stepOf, traceOf } from "../eval-html/traced-artifacts.js";
import { ComponentKind, ToolCallStatus } from "agboss";
import { envelope, agboss } from "./agboss.js";

const APPLICATION = new URL("../../../agboss/tests/flow/fixtures/evals.fixture.ts", import.meta.url)
  .pathname;
const CWD = mkdtempSync(join(tmpdir(), "agboss-eval-html-"));

/** A file in the test's folder with this content. */
function fileWith(name: string, content: string): string {
  const file = join(CWD, name);
  writeFileSync(file, content);
  return file;
}

const SAVED = fileWith("refunds.json", JSON.stringify(REFUNDS_ARTIFACT));

describe("#397 PR 1: agboss eval run --html", () => {
  it("writes the artifact, then the page; both are in created", async () => {
    const report = join(CWD, "run", "run.json");
    const html = join(CWD, "run", "run.html");

    const call = await agboss(
      [
        "eval",
        "run",
        "--application",
        APPLICATION,
        "--suite",
        "desk-eval-suite",
        "--runs",
        "2",
        "--report",
        report,
        "--html",
        html,
        "--json",
      ],
      CWD,
    );

    expect(call.code).toBe(0);
    expect(envelope(call)).toMatchObject({ ok: true, created: [report, html] });
    expect(call.stderr).toMatch(
      new RegExp(`html → ${html} \\(\\d+\\.\\d KB, self-contained\\)`, "u"),
    );
    const page = readFileSync(html, "utf8");
    expect(page).toContain("<h1>desk-eval-suite</h1>");
    expect(page).toContain('<a class="dot dot-failed" href="#case-2-run-2"');
    expect(page).toContain('<div class="timeline"><p class="step-part-title">Timeline · '); // #397 PR 2
  });
});

describe("#397 PR 1: agboss eval show", () => {
  it("prints the saved run's table; --html writes the same page eval run writes", async () => {
    const html = join(CWD, "shown.html");

    const call = await agboss(["eval", "show", SAVED, "--html", html], CWD);

    expect(call.code).toBe(0);
    const lines = call.stdout.split("\n");
    expect(lines[0]).toBe(
      "refunds-eval-suite · refunds-workflow 1.4.0 · config 3f9a1c · 3 cases × 3 runs · env eval",
    );
    expect(lines[2]).toBe("refund-within-policy             yes     yes     ✓✓✓");
    expect(lines.at(-2)).toMatch(/^html → .*shown\.html \(\d+\.\d KB, self-contained\)$/u);
    expect(readFileSync(html, "utf8")).toContain("<h1>refunds-eval-suite</h1>");
  });

  it("--json: the artifact as read is the result, the page in created", async () => {
    const html = join(CWD, "shown-json.html");

    const call = await agboss(["eval", "show", SAVED, "--html", html, "--json"], CWD);

    expect(call.code).toBe(0);
    expect(envelope(call)).toMatchObject({
      ok: true,
      command: "eval",
      result: { kind: "agboss.eval-run", suite: "refunds-eval-suite" },
      created: [html],
    });
  });

  it("without --html it writes nothing", async () => {
    const call = await agboss(["eval", "show", SAVED, "--json"], CWD);

    expect(call.code).toBe(0);
    expect(envelope(call).created).toBeUndefined();
  });

  it("needs the artifact's path", async () => {
    const call = await agboss(["eval", "show", "--json"], CWD);

    expect(call.code).toBe(2);
    expect(envelope(call)).toMatchObject({ error: { code: "usage.missing-argument" } });
  });

  it.each([
    ["no such file", "missing.json", "eval.run-not-found", "no run artifact at missing.json"],
    ["not JSON", fileWith("text.json", "{ not json"), "eval.run-invalid", "not JSON"],
    [
      "another kind",
      fileWith("kind.json", '{"kind":"agboss.describe"}'),
      "eval.run-invalid",
      'kind is "agboss.describe", not "agboss.eval-run"',
    ],
    [
      "an unknown schema version",
      fileWith("version.json", JSON.stringify({ ...REFUNDS_ARTIFACT, schemaVersion: 3 })),
      "eval.run-invalid",
      "schemaVersion 3 — this agboss reads 1 to 2",
    ],
    [
      "a field missing",
      fileWith("field.json", JSON.stringify({ ...REFUNDS_ARTIFACT, cases: [{ name: "x" }] })),
      "eval.run-invalid",
      "cases.0.caseHash:",
    ],
  ])("refuses %s: exit 2, %s", async (_what, file, code, message) => {
    const call = await agboss(["eval", "show", file, "--json"], CWD);

    expect(call.code).toBe(2);
    const { error } = envelope(call) as { error: { code: string; message: string } };
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
  });

  it("does not write a page above its bound (the long reason is on the page twice: 18 MB): eval.report-too-large", async () => {
    const huge = artifactOf([
      caseOf("huge", [
        {
          run: 1,
          threadId: "thread-1",
          passed: false,
          checks: [
            {
              check: "trajectory",
              status: CheckStatus.Failed,
              reason: "x".repeat(9 * 1024 * 1024),
            },
          ],
          spentUsd: 0,
        },
      ]),
    ]);
    const file = fileWith("huge.json", JSON.stringify(huge));
    const html = join(CWD, "huge.html");

    const call = await agboss(["eval", "show", file, "--html", html, "--json"], CWD);

    expect(call.code).toBe(2);
    expect(envelope(call)).toMatchObject({
      error: {
        code: "eval.report-too-large",
        message: expect.stringMatching(
          /^the HTML report would be 18\.0 MB without any timeline, above its 16\.0 MB limit/u,
        ) as unknown,
      },
    });
    expect(existsSync(html)).toBe(false);
  });

  it("a page too large with every timeline keeps those of the cases without pass^k (#397 PR 2)", async () => {
    const value = { notes: "n".repeat(2000) };
    const step = stepOf("big-agent", ComponentKind.Agent, {
      toolCalls: [
        {
          tool: "big-tool",
          status: ToolCallStatus.Succeeded,
          input: value,
          output: value,
          isResultTruncated: false,
          validationAttempts: 0,
        },
      ],
    });
    const run = (number: number, passed: boolean) => ({
      run: number,
      threadId: `t${String(number)}`,
      passed,
      checks: [{ check: "trajectory", status: passed ? CheckStatus.Passed : CheckStatus.Failed }],
      spentUsd: 0,
      trace: { ...traceOf(String(number)), steps: Array.from({ length: 200 }, () => step) },
    });
    const runs = Array.from({ length: 20 }, (_, index) => index + 1);
    const big = artifactOf(
      [
        caseOf(
          "stable",
          runs.map((number) => run(number, true)),
        ),
        caseOf("failing", [run(1, false)]),
      ],
      20,
    );
    const file = fileWith("big.json", JSON.stringify({ ...big, schemaVersion: 2 }));
    const html = join(CWD, "big.html");

    const call = await agboss(["eval", "show", file, "--html", html], CWD);

    expect(call.code).toBe(0);
    expect(call.stdout).toMatch(
      /html → .*big\.html \(\d+\.\d (?:KB|MB), self-contained; timelines of cases without pass\^k only\)/u,
    );
    expect(readFileSync(html, "utf8")).toContain(
      "Timeline left out to keep the page under its size bound",
    );
  });

  it("has its own help", async () => {
    const call = await agboss(["eval", "show", "--help"], CWD);

    expect(call.stdout).toContain("agboss eval show <run.json> [--html <file>]");
  });
});
