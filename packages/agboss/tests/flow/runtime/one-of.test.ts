import { beforeEach, describe, expect } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  BugReportAction,
  OneOfReportFinish,
  OneOfTicketStart,
  OneOfTriageApplication,
  OtherReportAction,
  PingOneOfAction,
  QuestionReportAction,
  ran,
  SortAction,
} from "./fixtures/one-of.workflow.js";

const test = testWith(OneOfTriageApplication);

beforeEach(() => {
  ran.length = 0;
});

describe("#1275a: .toOneOf([…]) runs the branch of the variant the step gave", () => {
  test("each variant goes to the branch whose first step reads it", async ({ app }) => {
    const bug = await execute(app, OneOfTicketStart, { text: "it crashes", kind: "bug" });
    const question = await execute(app, OneOfTicketStart, { text: "how?", kind: "question" });

    expect(bug).toFollowPath([OneOfTicketStart, SortAction, BugReportAction, OneOfReportFinish]);
    expect(question).toFollowPath([
      OneOfTicketStart,
      SortAction,
      PingOneOfAction,
      QuestionReportAction,
      OneOfReportFinish,
    ]);
    expect(ran).toEqual(["bug", "ping", "question"]);
  });

  test("the one branch that reads no variant takes the variant left", async ({ app }) => {
    const other = await execute(app, OneOfTicketStart, { text: "hm", kind: "unmarked" });

    expect(other).toFollowPath([
      OneOfTicketStart,
      SortAction,
      OtherReportAction,
      OneOfReportFinish,
    ]);
    expect(other).toFinishWith(OneOfReportFinish, { text: "other" });
    expect(ran).toEqual(["other"]);
  });
});
