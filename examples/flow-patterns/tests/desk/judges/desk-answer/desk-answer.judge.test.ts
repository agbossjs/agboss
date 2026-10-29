import { expect, it } from "vitest";
import { WorkflowFinishTextDto } from "@agboss/core/dto";
import { testJudge } from "@agboss/core/testing";
import { DeskAnswerJudge } from "../../../../src/desk/judges/desk-answer/desk-answer.judge.js";

it("testJudge: the eval suite's judge on a finish's output, with the metrics calibrate reads", async () => {
  const runJudge = testJudge(DeskAnswerJudge);
  const answer = (text: string) =>
    runJudge({
      variant: WorkflowFinishTextDto,
      reply: { text },
      task: "Answer",
      attempt: 0,
      toolCalls: [],
    });

  expect((await answer("It says: order 7 shipped")).output).toMatchObject({
    passed: true,
    metrics: { quotesTool: true },
  });
  expect((await answer("Do you have a recent order?")).output).toMatchObject({
    passed: false,
    reason: "the answer does not say where the order is",
  });
});
