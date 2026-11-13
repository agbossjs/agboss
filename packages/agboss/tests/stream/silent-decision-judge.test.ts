/** #1004 AC1: a judge on a decision model (`judgeModel.decide`) is silent. */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  AnswerGrounded,
  DecisionDeskApplication,
  Writer,
} from "../judges/fixtures/decision-judged.workflow.js";
import { TaskStart } from "../judges/fixtures/judged.workflow.js";
import { deltas } from "./writer.fixture.js";

const test = testWith(DecisionDeskApplication);

describe("#1004: the decision judge is silent", () => {
  test("AC1: only the writer's answer is a delta", async ({ app, mockLlm }) => {
    mockLlm(Writer).thenReturn(replyWith("Acme is hiring a TS engineer."));
    mockLlm(AnswerGrounded).thenReturn(decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }));
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      TaskStart,
      { text: "find a TS job" },
      { onStream: (event) => events.push(event) },
    );

    expect(mockLlm(AnswerGrounded).requests).toHaveLength(1);
    expect(deltas(events)).toEqual(["Acme is hiring a TS engineer."]);
  });
});
