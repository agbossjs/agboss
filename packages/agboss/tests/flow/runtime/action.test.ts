import { beforeEach, describe, expect } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ClassifyAction,
  reported,
  ReportFinish,
  TicketStart,
  TriageApplication,
} from "./fixtures/triage.workflow.js";

const test = testWith(TriageApplication);

beforeEach(() => {
  reported.length = 0;
});

describe("#272: an @Action runs execute(input) with its fields from the path scope", () => {
  test("its variant(XDto, value) picks the case; the finish tells the variants apart", async ({
    app,
  }) => {
    const bug = await execute(app, TicketStart, { text: "it crashes", kind: "bug" });
    const question = await execute(app, TicketStart, { text: "how?", kind: "question" });

    expect(bug).toFollowPath([TicketStart, ClassifyAction, ReportFinish]);
    expect(bug).toFinishWith(ReportFinish, { text: "a bug" });
    expect(question).toFinishWith(ReportFinish, { text: "a question" });
    expect(reported).toEqual([
      { producer: "ClassifyAction", bug: true },
      { producer: "ClassifyAction", bug: false },
    ]);
  });

  test("a oneOf value without variant(…) fails the step: the class is never guessed", async ({
    app,
  }) => {
    const run = execute(app, TicketStart, { text: "?", kind: "unmarked" });

    await expect(run).rejects.toFailWith({ code: "step.output-invalid" });
    await expect(run).rejects.toThrow("return variant(XDto, value)");
  });

  test("the record names who gave each value and what it was built from", async ({ app }) => {
    const result = await execute(app, TicketStart, { text: "x", kind: "bug" }, { record: true });

    expect(result.output).toEqual({ text: "a bug" });
    expect(result.record?.scope).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: "BugDto",
          producer: "classify-action",
          builtFrom: ["ticket-workflow-start:1/TicketDto"],
        }),
      ]),
    );
  });
});
