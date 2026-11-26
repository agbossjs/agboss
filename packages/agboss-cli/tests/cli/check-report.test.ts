/**
 * #268 AC5 — the report of `agboss check`: per start the worst case of one call, each number with
 * how it is made up, read from the decorators only (no `maxSpend()`); then the process variables
 * the application's `defineEnv` references need — names marked `value` / `secret` / optional, never
 * a value (M1: `agboss check` in flow-patterns, #489 — job-scout's `prod` before).
 */
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, agbossProcess, envelope, fixture } from "./agboss.js";

const FLOW_PATTERNS = fileURLToPath(
  new URL("../../../../examples/flow-patterns/", import.meta.url),
);
const REPORT = fixture("cli/report.workflow.ts");
const CWD = mkdtempSync(join(tmpdir(), "agboss-check-report-"));

describe("#268 AC5: the worst case per start, decorators only", () => {
  it("a child workflow per item: each number with how it is made up, no maxSpend() called", async () => {
    const call = await agboss(["check", "--application", REPORT], CWD);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "report-application 2.0.0, profiles dev",
        "",
        "Worst case of one batch-report-workflow-start call",
        "  workflow executions  51  1 batch-report-workflow + 50 item-report-workflow (maxItems 50)",
        "  at the same time     5   1 batch-report-workflow + 4 item-report-workflow (maxConcurrency 4)",
        "  steps                52  2 in batch-report-workflow (longest path) + 50 × 1 in item-report-workflow (longest path)",
        "  nesting depth        2   batch-report-workflow → item-report-workflow",
        "",
        "Worst case of one item-report-workflow-start call",
        "  workflow executions  1  1 item-report-workflow",
        "  at the same time     1  1 item-report-workflow",
        "  steps                1  1 in item-report-workflow (longest path)",
        "  nesting depth        1  item-report-workflow",
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
          title: "report-application 2.0.0, profiles dev",
          starts: [
            {
              start: "batch-report-workflow-start",
              workflow: "batch-report-workflow",
              rows: [
                { measure: "workflow executions", total: 51 },
                { measure: "at the same time", total: 5 },
                { measure: "steps", total: 52 },
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

describe("#489 AC2: #268 AC5 the process variables are listed by name, never a value", () => {
  it("flow-patterns' dev: the storage's and the providers' (defineEnv), secret, optional and defaulted, no values (M1)", () => {
    const call = agbossProcess(["check"], FLOW_PATTERNS, {
      OPENROUTER_API_KEY: "sk-or-not-printed",
      AGBOSS_SQLITE_PATH: ":memory:",
      PII_PSEUDONYM_KEY: "pii-key-not-printed",
      AGBOSS_IDEMPOTENCY_SECRET: "idempotency-key-not-printed",
    });

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      [
        "flow-patterns-application 1.0.0, profiles dev",
        "",
        "Worst case of one offer-workflow-start call",
        "  workflow executions  1   1 offer-workflow",
        "  at the same time     1   1 offer-workflow",
        "  steps                12  12 in offer-workflow (maxSteps)",
        "  nesting depth        1   offer-workflow",
        "",
      ].join("\n"),
    );
    expect(call.stdout).toContain(
      [
        "the application needs 5 process variables:",
        "  AGBOSS_SQLITE_PATH         value, has a default",
        "  AGBOSS_IDEMPOTENCY_SECRET  secret",
        "  PII_PSEUDONYM_KEY          secret",
        "  OPENROUTER_BASE_URL        value, has a default",
        "  OPENROUTER_API_KEY         secret",
        "",
      ].join("\n"),
    );
    expect(call.stdout).not.toContain("sk-or-not-printed");
    expect(call.stdout).not.toContain("pii-key-not-printed");
    expect(call.stdout).not.toContain("idempotency-key-not-printed");
    expect(call.stdout).not.toContain(":memory:");
    expect(call.stdout).not.toContain(".agboss/flow-patterns.sqlite");
  });

  it("--json: the variables as data", () => {
    const call = agbossProcess(["check", "--json"], FLOW_PATTERNS);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        report: {
          environment: {
            variables: [
              { variable: "AGBOSS_SQLITE_PATH", use: "value", required: false, optional: false },
              { variable: "AGBOSS_IDEMPOTENCY_SECRET", use: "secret", required: true },
              { variable: "PII_PSEUDONYM_KEY", use: "secret", required: true },
              { variable: "OPENROUTER_BASE_URL", use: "value", required: false },
              { variable: "OPENROUTER_API_KEY", use: "secret", required: true },
            ],
          },
        },
      },
    });
  });

  it("the title names the profiles the application runs with", () => {
    const call = agbossProcess(["check"], FLOW_PATTERNS);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain("flow-patterns-application 1.0.0, profiles dev\n");
  });
});
