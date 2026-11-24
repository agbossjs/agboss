/** #659 AC6: `agboss describe` shows each question step, its role, ask → answer and who answers. */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { ChannelImplementationReason, describedChannelsOf } from "../../src/describe/channels.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { QuestionsApplication } from "../flow/fixtures/questions.fixture.js";
import { PauseRespondent } from "../../src/pause/respondent.js";

const questions = await applicationOf(QuestionsApplication);

describe("#659 AC6: describe shows the question steps", () => {
  it("AC6: the role as data: ask → answer, who answers, its interpreter, where it is asked", () => {
    const channels = describedChannelsOf(questions);

    expect(
      channels.find((channel) => channel.name === "spending-limit-question-external-task"),
    ).toEqual({
      name: "spending-limit-question-external-task",
      className: "SpendingLimitQuestionExternalTask",
      isRole: true,
      question: "PurchaseQuestionDto",
      answer: "SpendingLimitAnswerDto",
      respondent: PauseRespondent.Owner,
      expiresIn: 365 * 24 * 3_600_000,
      replyInterpreter: "spending-limit-reply-interpreter",
      implementation: "InboxSpendingLimitChannel",
      reason: ChannelImplementationReason.Listed,
      tools: [],
      askedBy: ["spending-limit-question-external-task (purchase-workflow)"],
    });
  });

  it("AC6: the text: the channel line and the flow's .toExternalTask(…)", () => {
    const lines = describeAssembledApplication(questions);

    expect(lines).toContain(
      "  budget-owner-question-external-task (BudgetOwnerQuestionExternalTask): PurchaseQuestionDto → SpendingLimitAnswerDto · answered by the channel · expires in 8760 h · channel interpreter budget-owner-reply-interpreter · InboxBudgetOwnerChannel (listed in @Application channels) · asked at budget-owner-question-external-task (owner-purchase-workflow)",
    );
    const text = lines.join("\n");
    expect(text).toContain(".toExternalTask(SpendingLimitQuestionExternalTask)");
    expect(text).toContain("onExternalTask(BudgetOwnerQuestionExternalTask)");
    expect(text).toMatch(/maxVisits [^\n]*budget-owner-question-external-task 2/);
  });
});
