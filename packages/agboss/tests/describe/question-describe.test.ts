/** #659 AC6: `agboss describe` shows each question step, its role, ask → answer and who answers. */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelImplementationReason, describedChannelsOf } from "../../src/describe/channels.js";
import { describeApplication } from "../../src/describe/describe-application.js";
import { QuestionsApplication } from "../flow/fixtures/questions.fixture.js";

const questions = await applicationOf(QuestionsApplication);

describe("#659 AC6: describe shows the question steps", () => {
  it("AC6: the role as data: ask → answer, who answers, its interpreter, where it is asked", () => {
    const channels = describedChannelsOf(questions);

    expect(channels.find((channel) => channel.name === "spending-limit-question")).toEqual({
      name: "spending-limit-question",
      className: "SpendingLimitQuestion",
      isRole: true,
      question: "PurchaseQuestionDto",
      answer: "SpendingLimitAnswerDto",
      answerer: PauseAnswerer.ThreadOwner,
      answeredBy: PauseAnswerer.ThreadOwner,
      replyInterpreter: "spending-limit-reply-interpreter",
      implementation: "InboxSpendingLimitChannel",
      reason: ChannelImplementationReason.Listed,
      tools: [],
      askedBy: ["spending-limit-question (purchase-workflow)"],
    });
  });

  it("AC6: the text: the channel line and the flow's .toQuestion(…)", () => {
    const lines = describeApplication(questions);

    expect(lines).toContain(
      "  budget-owner-question (BudgetOwnerQuestion): PurchaseQuestionDto → SpendingLimitAnswerDto · answered by the channel · reply interpreter budget-owner-reply-interpreter · InboxBudgetOwnerChannel (listed in @Application providers) · asked at budget-owner-question (owner-purchase-workflow)",
    );
    const text = lines.join("\n");
    expect(text).toContain(".toQuestion(SpendingLimitQuestion)");
    expect(text).toContain("question(BudgetOwnerQuestion)");
    expect(text).toMatch(/maxVisits [^\n]*budget-owner-question 2/);
  });
});
