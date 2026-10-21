/**
 * #268 AC5 — the report of `agboss check`: per start the worst case of one call, each number with
 * how it is made up, read from the decorators only (no `maxSpend()`); with `--env <name>` the
 * process variables that environment needs — names marked `value` / `secret` / optional, never a
 * value (M1: `agboss check --env prod` in job-scout).
 */
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

const JOB_SCOUT = fileURLToPath(new URL("../../../../examples/job-scout/", import.meta.url));
const REPORT = fixture("cli/report.workflow.ts");
const CWD = mkdtempSync(join(tmpdir(), "agboss-check-report-"));

describe("#268 AC5: the worst case per start, decorators only", () => {
  it("a child workflow per item: each number with how it is made up, no maxSpend() called", async () => {
    const call = await agboss(["check", "--application", REPORT], CWD);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "report-application 2.0.0, environment dev",
        "",
        "Worst case of one batch-report-workflow-start call",
        "  workflow executions     51  1 batch-report-workflow + 50 item-report-workflow (maxItems 50)",
        "  at the same time        5   1 batch-report-workflow + 4 item-report-workflow (maxConcurrency 4)",
        "  agent and router steps  51  1 in batch-report-workflow (longest path) + 50 × 1 in item-report-workflow (longest path)",
        "  nesting depth           2   batch-report-workflow → item-report-workflow",
        "",
        "Worst case of one item-report-workflow-start call",
        "  workflow executions     1  1 item-report-workflow",
        "  at the same time        1  1 item-report-workflow",
        "  agent and router steps  1  1 in item-report-workflow (longest path)",
        "  nesting depth           1  item-report-workflow",
        "",
      ].join("\n"),
    );
    expect(call.stdout).not.toContain("maxSpend");
  });

  it("--json carries the report as data: each start's rows", async () => {
    const call = await agboss(["check", "--application", REPORT, "--json"], CWD);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        report: {
          title: "report-application 2.0.0, environment dev",
          starts: [
            {
              start: "batch-report-workflow-start",
              workflow: "batch-report-workflow",
              rows: [
                { measure: "workflow executions", total: 51 },
                { measure: "at the same time", total: 5 },
                { measure: "agent and router steps", total: 51 },
                { measure: "nesting depth", total: 2 },
              ],
            },
            { start: "item-report-workflow-start", workflow: "item-report-workflow" },
          ],
        },
      },
    });
  });
});

describe("#268 AC5: --env lists the process variables by name, never a value", () => {
  it("job-scout's prod: secret, optional and defaulted variables, no values (M1)", async () => {
    const call = await agboss(["check", "--env", "prod"], JOB_SCOUT, {
      OPENROUTER_API_KEY: "sk-or-not-printed",
      AGBOSS_SQLITE_PATH: ":memory:",
    });

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "job-scout-application 1.0.0, environment prod",
        "",
        "Worst case of one chat-workflow-start call",
        "  workflow executions     1  1 job-scout-workflow",
        "  at the same time        1  1 job-scout-workflow",
        "  agent and router steps  2  2 in job-scout-workflow (longest path)",
        "  nesting depth           1  job-scout-workflow",
        "",
        "prod environment needs 3 process variables:",
        "  OPENROUTER_API_KEY   secret",
        "  OPENROUTER_BASE_URL  value, optional",
        "  AGBOSS_SQLITE_PATH   value, has a default",
        "",
      ].join("\n"),
    );
    expect(call.stdout).not.toContain("sk-or-not-printed");
    expect(call.stdout).not.toContain(":memory:");
    expect(call.stdout).not.toContain("/var/lib/job-scout");
  });

  it("--json: the environment's variables as data", async () => {
    const call = await agboss(["check", "--env", "prod", "--json"], JOB_SCOUT);

    expect(envelope(call)).toMatchObject({
      result: {
        report: {
          environment: {
            name: "prod",
            variables: [
              { variable: "OPENROUTER_API_KEY", use: "secret", required: true },
              { variable: "OPENROUTER_BASE_URL", use: "value", optional: true },
              { variable: "AGBOSS_SQLITE_PATH", use: "value", required: false, optional: false },
            ],
          },
        },
      },
    });
  });

  it("without --env no variables are listed; the title names the default environment", async () => {
    const call = await agboss(["check"], JOB_SCOUT);

    expect(call.stdout).toContain("job-scout-application 1.0.0, environment dev\n");
    expect(call.stdout).not.toContain("process variable");
  });
});
