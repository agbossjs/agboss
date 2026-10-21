import { describe, expect, it } from "vitest";
import { startsOfApplication } from "agboss/internal";
import { NoTextStartError, textStartOrFail } from "../../src/cli/text-start.js";
import { DeskApplication } from "../fixtures/cli/desk/desk.workflow.js";
import { TestApplication } from "../../../agboss/tests/fixtures/test-workflow/test.workflow.js";

describe("#268: agboss chat sends a text — its start takes WorkflowStartTextDto", () => {
  it("a start taking a text is the chat's", () => {
    const [chat] = startsOfApplication(TestApplication);
    if (chat === undefined) throw new Error("a start");

    expect(textStartOrFail(chat)).toBe(chat);
  });

  it("a start taking a DTO cannot chat: the error names it", () => {
    const batch = startsOfApplication(DeskApplication).find(
      (start) => start.workflow !== "inbox-workflow",
    );
    if (batch === undefined) throw new Error("a start");

    expect(() => textStartOrFail(batch)).toThrow(NoTextStartError);
    expect(() => textStartOrFail(batch)).toThrow(/batch-screening-workflow-start/);
  });
});
