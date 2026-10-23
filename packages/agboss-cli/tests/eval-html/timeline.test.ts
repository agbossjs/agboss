/**
 * #397 PR 2 — the page of a version 2 artifact: each run's timeline (steps, model calls, tool calls
 * with their values, validation attempts, guardrails, judges with retries, side-path failures,
 * pauses, undo actions, a child nested), the output beside the case's expectation, where an
 * unstable case's attempts part ways, the comparison with a baseline, and the size of a full run.
 */
import { describe, expect, it } from "vitest";
import { ComponentKind, ToolCallStatus } from "agboss";
import { CheckStatus } from "agboss/eval";
import type { EvalCaseReport, EvalRunResult } from "agboss/eval";
import { renderEvalReportPage, TimelineDetail } from "../../src/eval/html/report-page.js";
import { MAX_VALUE_CHARACTERS } from "../../src/eval/html/value-view.js";
import { MAX_HTML_REPORT_SIZE } from "../../src/eval/html-report.js";
import { artifactOf, caseOf, REFUNDS_ARTIFACT } from "./artifacts.js";
import { stepOf, traceOf, TRACED_ARTIFACT } from "./traced-artifacts.js";

const PAGE = renderEvalReportPage(TRACED_ARTIFACT);

/** The part of the page from one run's details to its end. */
const runOf = (page: string, anchor: string): string => {
  const start = page.indexOf(`<details class="run" id="${anchor}">`);
  const end = page.indexOf('<details class="run"', start + 1);
  return page.slice(start, end < 0 ? undefined : end);
};

describe("#397 PR 2: a run's timeline", () => {
  const run = runOf(PAGE, "case-1-run-1");

  it("every step in order, anchored: kind, node, visit, input hash, spend, time", () => {
    const steps = [
      ...run.matchAll(
        /<li class="step" id="([^"]+)"><p class="step-head"><span class="kind">([^<]+)<\/span> <strong>([^<]+)<\/strong> · ([^<]+)</gu,
      ),
    ];

    expect(steps.slice(0, 3).map(([, id, kind, node, line]) => [id, kind, node, line])).toEqual([
      [
        "case-1-run-1-step-1",
        "workflow-start",
        "refund-workflow-start",
        "visit 1 · input input-of-r · $0.0000 · 850 ms",
      ],
      [
        "case-1-run-1-step-2",
        "agent",
        "refund-agent",
        "visit 1 · input input-of-r · $0.0120 · 850 ms",
      ],
      [
        "case-1-run-1-step-3",
        "workflow-finish",
        "refund-workflow-finish",
        "visit 1 · input input-of-r · $0.0000 · 850 ms",
      ],
    ]);
    expect(run).toContain(
      "Timeline · refund-workflow-start → refund-agent → refund-workflow-finish",
    );
  });

  it("an agent's model calls, tool call with its values, validation, guardrail, judges with retries", () => {
    expect(run).toContain(
      '<tr><th scope="row">moonshotai/kimi-k2.6</th><td>refund-agent</td><td class="number">812</td><td class="number">64</td><td class="number">512</td><td class="number">$0.0120</td></tr>',
    );
    expect(run).toContain(
      '<summary><code>get-order-tool</code> <span class="status status-call-succeeded">succeeded</span> · model call 1 · result truncated for the model</summary>',
    );
    expect(run).toContain(
      "<figcaption>Input</figcaption><pre><code>{\n  &quot;orderId&quot;: &quot;7&quot;\n}</code></pre>",
    );
    expect(run).toContain("&lt;email&gt;"); // shown as the artifact masked it
    expect(run).toContain("1 answer(s) or tool argument(s) failed validation and were sent back");
    expect(run).toContain("<li>legal-advice-guardrail (input): passed, p = 0.07</li>");
    expect(run).toContain("<li>answer-grounded-judge on reply 1: failed — invents a fee</li>");
    expect(run).toContain("<li>answer-grounded-judge on reply 2: passed — score: 4</li>");
  });

  it("side-path failures, pauses, undo actions, a child nested, and the output", () => {
    expect(run).toContain("<li>refund-agent → notify-action: step.agent the agent failed</li>");
    expect(run).toContain(
      "<li>refund-agent asked refund-approval-channel: replied by owner-1 — {&quot;approved&quot;:true}</li>",
    );
    expect(run).toContain(
      "<li>refund-charge-action undid charge-action (side-path): compensated</li>",
    );
    expect(run).toContain(
      '<details class="child"><summary><strong>vendor-check-workflow</strong> · failed · item 0 · launched by vendor-check-workflow</summary><p class="run-error"><code>step.failed</code> the vendor check failed</p>',
    );
    expect(run).toContain("<figcaption>Output at refund-workflow-finish</figcaption>");
  });

  it("the case's expectation beside its runs", () => {
    expect(PAGE).toContain(
      "<dt>Requires</dt><dd>get-order-tool with {&quot;orderId&quot;:&quot;7&quot;}</dd></div><div><dt>Forbids</dt><dd>delete-order-tool</dd></div><div><dt>Invariants on</dt><dd>refund-tool</dd></div><div><dt>Checks, in order</dt><dd>trajectory → answer-grounded-judge</dd>",
    );
  });

  it("a version 1 run says it has no timeline", () => {
    expect(renderEvalReportPage(REFUNDS_ARTIFACT)).toContain(
      "No timeline: the artifact holds none for this run",
    );
  });

  it("a long value is cut on the page, the artifact keeps it", () => {
    const long = "x".repeat(MAX_VALUE_CHARACTERS * 2);
    const trace = traceOf("9", { output: { text: long } });
    const run: EvalRunResult = {
      run: 1,
      threadId: "t",
      passed: true,
      checks: [],
      spentUsd: 0,
      trace,
    };

    const page = renderEvalReportPage(artifactOf([caseOf("long", [run])], 1));

    expect(page).toContain("more characters in the run artifact]");
    expect(page).not.toContain(long);
  });
});

describe("#397 PR 2: unstable cases name where their attempts part ways", () => {
  it("links the step of the first run where the runs differ, and why", () => {
    expect(PAGE).toContain(
      '<li><a href="#case-2">looks-the-order-up</a> — 1 of 2 runs passed — the attempts part ways at <a href="#case-2-run-1-step-2" data-opens>refund-agent</a> (visit 1): the same input, other tool calls</li>',
    );
    expect(PAGE).toContain('<li class="step" id="case-2-run-1-step-2">');
  });
});

describe("#397 PR 2: the comparison with a baseline", () => {
  it("what it was compared with, the regressions, every case with its verdict", () => {
    expect(PAGE).toContain(
      '<section id="baseline" aria-labelledby="baseline-title"><h2 id="baseline-title">Against the baseline</h2>',
    );
    expect(PAGE).toContain("<dt>Baseline</dt><dd>.agboss/eval/main.json</dd>");
    expect(PAGE).toContain("<dt>Regressed</dt><dd>looks-the-order-up</dd>");
    expect(PAGE).toContain("1 regressed · 1 unchanged · 1 removed");
    expect(PAGE).toContain(
      '<tr class="verdict-regressed"><th scope="row"><a href="#case-2">looks-the-order-up</a></th><td class="number">2/2</td><td class="number">1/2</td><td><span class="badge badge-failed">regressed</span></td></tr>',
    );
    expect(PAGE).toContain(
      '<tr class="verdict-removed"><th scope="row"><span>refund-by-phone</span></th><td class="number">1/2</td><td class="number">—</td>',
    );
  });

  it("is left out of a run made without --baseline", () => {
    expect(renderEvalReportPage(REFUNDS_ARTIFACT)).not.toContain('id="baseline"');
  });
});

describe("#397 PR 2: the page of a large run stays under its bound", () => {
  it("40 cases × 5 runs × 10 steps with 2 KB tool values each: under 16 MB", () => {
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
    const run = (number: number): EvalRunResult => ({
      run: number,
      threadId: `t${String(number)}`,
      passed: true,
      checks: [{ check: "trajectory", status: CheckStatus.Passed }],
      spentUsd: 0,
      trace: { ...traceOf(String(number)), steps: Array.from({ length: 10 }, () => step) },
    });
    const cases: EvalCaseReport[] = Array.from({ length: 40 }, (_, index) =>
      caseOf(`case-${String(index)}`, [1, 2, 3, 4, 5].map(run)),
    );

    const bytes = Buffer.byteLength(renderEvalReportPage(artifactOf(cases, 5)), "utf8");

    expect(bytes).toBeLessThan(MAX_HTML_REPORT_SIZE);
  });
});

describe("#397 PR 2: a page too large for every timeline leaves some out", () => {
  it("only the timelines of cases without pass^k; the unstable link still reaches its step", () => {
    const page = renderEvalReportPage(TRACED_ARTIFACT, TimelineDetail.Failing);

    expect(runOf(page, "case-1-run-1")).toContain(
      "Timeline left out to keep the page under its size bound",
    );
    expect(runOf(page, "case-2-run-1")).toContain('<div class="timeline">');
    expect(page).toContain('href="#case-2-run-1-step-2" data-opens');
    expect(page).toContain(
      "Timelines of cases with pass^k are left out to keep the page under its size bound.",
    );
  });

  it("no timeline at all: the unstable link opens the run", () => {
    const page = renderEvalReportPage(TRACED_ARTIFACT, TimelineDetail.None);

    expect(page).not.toContain('<div class="timeline">');
    expect(page).toContain('href="#case-2-run-1" data-opens>refund-agent</a>');
  });
});
