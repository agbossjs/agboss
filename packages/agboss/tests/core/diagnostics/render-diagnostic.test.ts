import { describe, expect, it } from "vitest";
import { renderDiagnostic } from "../../../src/core/diagnostics/render-diagnostic.js";

/** #1325c: the rustc-style snippet — primary `^^^`, secondary `---`, notes, help, patch. */

const FILE = "/w/src/offer.workflow.ts";

/** A file whose line `n` is `lines[n - 1]`. */
const sourceOf =
  (...lines: readonly string[]) =>
  (file: string): string | undefined =>
    file === FILE ? lines.join("\n") : undefined;

const OFFER_SOURCE = sourceOf(
  ...Array.from({ length: 21 }, (_, index) => `// line ${String(index + 1)}`),
  "      .toAgent(OfferAgent)",
  "      .toAgent(CriticAgent)",
  "      .toAgent(RewriterAgent)",
  "      .toAgent(PublisherAgent)",
);

describe("renderDiagnostic", () => {
  it("draws the primary and secondary underlines of a call, gaps as `...`", () => {
    const text = renderDiagnostic(
      {
        code: "input.outdated-on-path",
        message: "`PublisherAgent` reads outdated `OfferDraftDto` after loop step",
        primary: {
          span: { file: FILE, line: 25, column: 8 },
          label: "reads stale `OfferDraftDto`",
        },
        secondary: [
          { span: { file: FILE, line: 22, column: 8 }, label: "first produced here" },
          { span: { file: FILE, line: 24, column: 8 }, label: "loop invalidates it here" },
        ],
        notes: ["a field never falls back to an older value"],
        help: "produce a fresh `OfferDraftDto` after `RewriterAgent`",
        patch:
          "24 |       .toAgent(RewriterAgent)\n25 +       .toAgent(OfferAgent)\n26 |       .toAgent(PublisherAgent)",
      },
      { readSource: OFFER_SOURCE, cwd: "/w", explainHint: true },
    );

    expect(text).toBe(
      [
        "error[input.outdated-on-path]: `PublisherAgent` reads outdated `OfferDraftDto` after loop step",
        "  --> src/offer.workflow.ts:25:8",
        "   |",
        "22 |       .toAgent(OfferAgent)",
        "   |        ------------------- first produced here",
        "23 |       .toAgent(CriticAgent)",
        "24 |       .toAgent(RewriterAgent)",
        "   |        ---------------------- loop invalidates it here",
        "25 |       .toAgent(PublisherAgent)",
        "   |        ^^^^^^^^^^^^^^^^^^^^^^^ reads stale `OfferDraftDto`",
        "   |",
        "   = note: a field never falls back to an older value",
        "   = help: produce a fresh `OfferDraftDto` after `RewriterAgent`",
        "   |",
        "24 |       .toAgent(RewriterAgent)",
        "25 +       .toAgent(OfferAgent)",
        "26 |       .toAgent(PublisherAgent)",
        "",
        "For more information about this error, try `agboss explain input.outdated-on-path`.",
      ].join("\n"),
    );
  });

  it("skips a gap of two or more lines with `...`", () => {
    const text = renderDiagnostic(
      {
        code: "graph.dead-end",
        message: "a path stops",
        primary: { span: { file: FILE, line: 25, column: 8 }, label: "here" },
        secondary: [{ span: { file: FILE, line: 22, column: 8 }, label: "starts here" }],
      },
      { readSource: OFFER_SOURCE, cwd: "/w" },
    );

    expect(text).toContain("   |        ------------------- starts here\n...\n25 |");
  });

  it("puts two marks of one line on one row, the nearer label first", () => {
    const text = renderDiagnostic(
      {
        code: "x.y",
        message: "two on one line",
        primary: { span: { file: FILE, line: 1, column: 5, endColumn: 8 }, label: "right" },
        secondary: [{ span: { file: FILE, line: 1, column: 1, endColumn: 3 }, label: "left" }],
      },
      { readSource: sourceOf("ab  cde  fg"), cwd: "/w" },
    );

    expect(text.split("\n").slice(2)).toEqual([
      "  |",
      "1 | ab  cde  fg",
      "  | --  ^^^ right",
      "  | |",
      "  | left",
    ]);
  });

  it("shows a tab as four spaces and keeps the underline under its token", () => {
    const text = renderDiagnostic(
      {
        code: "x.y",
        message: "tabbed",
        primary: { span: { file: FILE, line: 1, column: 2 }, label: "here" },
      },
      { readSource: sourceOf("\ttoAgent(A)"), cwd: "/w" },
    );

    expect(text.split("\n").slice(3)).toEqual(["1 |     toAgent(A)", "  |     ^^^^^^^^^^ here"]);
  });

  it("keeps the location and drops the snippet when the file cannot be read", () => {
    const text = renderDiagnostic(
      {
        code: "x.y",
        message: "gone",
        primary: { span: { file: "/w/gone.ts", line: 3, column: 4 }, label: "here" },
        notes: ["n"],
      },
      { readSource: () => undefined, cwd: "/w" },
    );

    expect(text).toBe("error[x.y]: gone\n --> gone.ts:3:4\n  = note: n");
  });

  it("names a secondary span of another file without quoting it", () => {
    const text = renderDiagnostic(
      {
        code: "x.y",
        message: "two files",
        primary: { span: { file: FILE, line: 22, column: 8 }, label: "here" },
        secondary: [
          { span: { file: "/w/src/other.ts", line: 9, column: 2 }, label: "declared here" },
        ],
      },
      { readSource: OFFER_SOURCE, cwd: "/w" },
    );

    expect(text).toContain("  ::: src/other.ts:9:2 declared here");
    expect(text).not.toContain("9 |");
  });

  it("prints only the header and notes when nothing has a place", () => {
    const text = renderDiagnostic(
      { code: "limits.timeout-invalid", message: "bad", notes: ["a", "b"], help: "fix" },
      { cwd: "/w" },
    );

    expect(text).toBe(
      "error[limits.timeout-invalid]: bad\n  = note: a\n  = note: b\n  = help: fix",
    );
  });
});
