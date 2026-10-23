/**
 * #397 PR 1 — the HTML report rendered from run artifacts: its structure (headings, landmarks,
 * dots, runs — not pixels), what it shows of each run, the sections shown only with their data, no
 * external request, and every artifact value escaped.
 */
import { createHash } from "node:crypto";
import { CheckStatus } from "agboss/eval";
import { describe, expect, it } from "vitest";
import { renderEvalReportPage } from "../../src/eval/html/report-page.js";
import { artifactOf, caseOf, REFUNDS_ARTIFACT } from "./artifacts.js";

const PAGE = renderEvalReportPage(REFUNDS_ARTIFACT);

/** The page's skeleton: headings, sections, case entries, dots and runs, in order. */
function outlineOf(page: string): string[] {
  const pattern =
    /<(h[123])[^>]*>([^<]*)<|<section id="([^"]+)"|<a class="dot dot-(\w+)"[^>]*aria-label="([^"]+)"|<details class="run" id="([^"]+)"|<(header|main|footer)[ >]/gu;
  return [...page.matchAll(pattern)].map((found) => {
    const [, heading, title, section, dotStatus, dotLabel, run, landmark] = found;
    if (heading !== undefined) return `${heading} ${title ?? ""}`;
    if (section !== undefined) return `section #${section}`;
    if (dotStatus !== undefined) return `dot ${dotStatus} "${dotLabel ?? ""}"`;
    if (run !== undefined) return `run #${run}`;
    return `<${landmark ?? ""}>`;
  });
}

describe("#397 PR 1: the HTML report of a run artifact", () => {
  it("is one document: header, summary, unstable cases, cases with a dot and a run per attempt", () => {
    expect(PAGE.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">')).toBe(
      true,
    );
    expect(outlineOf(PAGE)).toMatchSnapshot();
  });

  it("the header names what the runs ran on, when and for how long", () => {
    for (const fact of [
      "<dt>Application</dt><dd>refunds-application 1.4.0</dd>",
      "<dt>Workflow</dt><dd>refunds-workflow 1.4.0</dd>",
      "<dt>Config</dt><dd>3f9a1c2b7d</dd>",
      "<dt>Start</dt><dd>refund-workflow-start</dd>",
      "<dt>Environment</dt><dd>eval</dd>",
      "<dt>Runs per case (k)</dt><dd>3</dd>",
      "<dt>Cascade</dt><dd>stop-at-first-failure</dd>",
      "<dt>Took</dt><dd>3 min 5 s</dd>",
    ])
      expect(PAGE).toContain(fact);
  });

  it("the summary: pass@k and pass^k as shares, cases, attempts, unstable, judge calls, spend", () => {
    const tiles = [
      ...PAGE.matchAll(
        /<span class="tile-label">([^<]+)<\/span><span class="tile-value">([^<]+)</gu,
      ),
    ];

    expect(tiles.map(([, label, value]) => `${label ?? ""} ${value ?? ""}`)).toEqual([
      "pass@3 2/3 (67%)",
      "pass^3 1/3 (33%)",
      "Cases 3",
      "Attempts 9",
      "Unstable 1",
      "Judge calls 4",
      "Spent $0.0602",
    ]);
  });

  it("a run's details: its execution, its error, every check with reason, skip, metrics and spend", () => {
    expect(PAGE).toContain("<dt>Execution</dt><dd>execution-1</dd>");
    expect(PAGE).toContain(
      '<p class="run-error"><code>limit.budget</code> execution execution-e3 spent $0.0500; execution-budget allows $0.05</p>',
    );
    expect(PAGE).toContain(
      '<th scope="row">trajectory</th><td><span class="status status-failed">failed</span></td><td>delete-order-tool called (forbidden)</td>',
    );
    expect(PAGE).toContain("<td>skipped: trajectory failed first</td>");
    expect(PAGE).toContain('<td>politeness: 0.92, tone: warm</td><td class="number">$0.0021</td>');
    expect(PAGE).toContain("No checks ran: the run ended before its last turn did.");
    expect(PAGE).toContain(
      '<p class="first-failure">First failure — run 2: trajectory: delete-order-tool called (forbidden)</p>',
    );
  });

  it("the unstable section and the filter's counts follow the cases", () => {
    expect(PAGE).toContain(
      '<li><a href="#case-2">prohibition-survives-compaction</a> — 1 of 3 runs passed</li>',
    );
    expect(PAGE).toContain('data-filter="all" aria-pressed="true">All (3)</button>');
    expect(PAGE).toContain('data-filter="failing" aria-pressed="false">Not pass^3 (2)</button>');
    expect(PAGE).toContain('data-filter="unstable" aria-pressed="false">Unstable (1)</button>');
  });

  it("no unstable case: the section is left out; no case: the cases section says so", () => {
    const stable = renderEvalReportPage(
      artifactOf([caseOf("stable", REFUNDS_ARTIFACT.cases[0]?.runResults ?? [])]),
    );
    const empty = renderEvalReportPage(artifactOf([]));

    expect(stable).not.toContain('id="unstable"');
    expect(empty).toContain("The suite has no cases.");
    expect(empty).toContain('<span class="tile-value">0/0</span>');
  });

  it("makes no request: no URL, no external resource, a CSP of its own style and script only", () => {
    const style = /<style>([\s\S]*)<\/style>/u.exec(PAGE)?.[1] ?? "";
    const script = /<script>([\s\S]*)<\/script>/u.exec(PAGE)?.[1] ?? "";
    const hash = (text: string): string => createHash("sha256").update(text).digest("base64");

    expect(PAGE).not.toMatch(/https?:|\/\/[a-z]|<link|<img|<iframe|\ssrc=|url\(|@import/iu);
    expect(PAGE.match(/<script/gu)).toHaveLength(1);
    const policy = `default-src 'none'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(script)}'; base-uri 'none'; form-action 'none'`;
    expect(PAGE).toContain(`content="${policy.replaceAll("'", "&#39;")}"`); // as the attribute escapes it
  });

  it("reads in light and dark, at phone width", () => {
    expect(PAGE).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(PAGE).toContain("@media (prefers-color-scheme: dark)");
    expect(PAGE).toContain("color-scheme: light dark;");
  });

  it("escapes every value of the artifact: case names, reasons, error messages, metrics", () => {
    const hostile = artifactOf([
      caseOf('<img src=x onerror="alert(1)">', [
        {
          run: 1,
          threadId: "t&1",
          passed: false,
          checks: [
            {
              check: "<b>judge</b>",
              status: CheckStatus.Failed,
              reason: "</script><script>alert(2)</script>",
              metrics: { "<i>": "'quoted'" },
            },
          ],
          error: { code: "x", message: "a <br> & b" },
          spentUsd: 0,
        },
      ]),
    ]);

    const page = renderEvalReportPage(hostile);

    expect(page.match(/<script/gu)).toHaveLength(1);
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>judge");
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(page).toContain("&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(page).toContain("a &lt;br&gt; &amp; b");
    expect(page).toContain("&lt;i&gt;: &#39;quoted&#39;");
    expect(page).toContain('aria-label="Runs of &lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
  });
});
