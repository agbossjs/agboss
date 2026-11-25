/**
 * #1328d: a case drafted from a kept execution is written with the pauses a person answered
 * (`answerPause`) and the end the run had (`expectedStatus`), the builders and the classes imported.
 */
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import type { EvalCaseDraft } from "@agboss/core/internal";
import { evalCaseSourceOf, withEvalCase } from "../../src/scaffold/eval-case-source.js";
import type { Component } from "../../src/scaffold/workflow-graph.js";

const declarations: readonly Component[] = [
  {
    className: "RefundApproval",
    path: "src/approvals/refund.approval.ts",
    decorator: "ToolApproval",
    id: "refund-approval",
  },
];

const draft: EvalCaseDraft = {
  name: "cancelled-refund",
  start: "desk-workflow-start",
  history: [],
  turns: [
    {
      input: { text: "Refund order 7" },
      pauses: [
        { target: "refund-approval", decision: { approved: true }, actor: { id: "alice" } },
        { target: "unknown-approval", decision: { approved: true } },
      ],
    },
  ],
  required: [],
  expectedStatus: ExecutionStatus.Cancelled,
};

describe("#1328d: a drafted case with pauses and an end", () => {
  it("writes answerPause for each answer whose class is found and expectedStatus", () => {
    const written = evalCaseSourceOf(draft, { declarations });

    expect(written.text).toBe(
      'evalCase({ name: "cancelled-refund", turns: [turn({"text":"Refund order 7"}, { pauses: [answerPause(RefundApproval, {"approved":true}, { actor: {"id":"alice"} })] })], expectedStatus: ExecutionStatus.Cancelled })',
    );
    expect(written.builders).toEqual(["evalCase", "turn", "answerPause"]);
    expect(written.core).toEqual(["ExecutionStatus"]);
    expect(written.classes.map((found) => found.className)).toEqual(["RefundApproval"]);
    expect(written.skipped).toEqual([
      "an answer of unknown-approval: no @ToolApproval or @ExternalTask class found",
    ]);
  });

  it("imports the builder, the status enum and the target class into the suite's file", () => {
    const suite = {
      path: "src/eval-suites/desk.eval-suite.ts",
      content: [
        'import { EvalSuite, evalCase } from "@agboss/core/eval";',
        'import { Workflow } from "@agboss/core";',
        "",
        '@EvalSuite({ name: "desk-eval-suite", start: DeskStart, cases: [ evalCase({ name: "a" }) ] })',
        "export class DeskEvalSuite {}",
        "",
      ].join("\n"),
    };

    const { file } = withEvalCase(suite, "desk-eval-suite", draft, { declarations });

    expect(file.content).toContain(
      'import { EvalSuite, evalCase, turn, answerPause } from "@agboss/core/eval";',
    );
    expect(file.content).toContain('import { Workflow, ExecutionStatus } from "@agboss/core";');
    expect(file.content).toContain(
      'import { RefundApproval } from "../approvals/refund.approval.js";',
    );
  });
});
