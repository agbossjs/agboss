/** #1004 AC1: the model judge's text never reaches the user's stream; a throwing listener is harmless. */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  AuditJudge,
  AuditJudgeApplication,
  AuditStart,
  AuditWriter,
  deltas,
} from "./writer.fixture.js";

const test = testWith(AuditJudgeApplication);

describe("#1004: the model judge is silent", () => {
  test("AC1: the judge's tokens do not reach onStream; the answer does", async ({
    app,
    mockModel,
  }) => {
    mockModel(AuditWriter).thenReturn(replyWith("The answer."));
    mockModel(AuditJudge).thenReturn(replyWith("PASS: SECRET JUDGE REASONING"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      AuditStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "The answer." });
    expect(mockModel(AuditJudge)).toHaveBeenCalledTimes(1);
    expect(deltas(events)).toEqual(["The answer."]);
  });

  test("a throwing onStream listener does not fail the run", async ({ app, mockModel }) => {
    mockModel(AuditWriter).thenReturn(replyWith("The answer."));
    mockModel(AuditJudge).thenReturn(replyWith("PASS"));
    const done = await execute(
      app,
      AuditStart,
      { text: "Q" },
      {
        onStream: () => {
          throw new Error("listener broke");
        },
      },
    );
    expect(done.output).toEqual({ text: "The answer." });
  });
});
