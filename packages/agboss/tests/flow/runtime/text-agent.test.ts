import { describe, expect, it } from "vitest";
import { workflowOf } from "../../../src/components/assemble.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Agent, GraphRuleError, Workflow, WorkflowFinish } from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { Alpha, TestAnswer, TestChat, TestMain } from "../../fixtures/test-flow/test.flow.js";
import { StarApplication } from "../../fixtures/test-flow/star.workflow.js";
import { execute, start } from "../../helpers/flow.js";

const star = testWith(StarApplication);

class SummaryDto {
  @Text({ prompt: "the summary" })
  text!: string;
}

@WorkflowFinish({ name: "summary-workflow-finish", description: "A summary", output: SummaryDto })
class SummaryFinish {}

@Agent({ name: "chatty-agent", description: "Answers with text", prompt: "Chat.", model: "test/c" })
class ChattyAgent {}

/** A text agent may lead only to a finish of `WorkflowFinishTextDto`. */
@Workflow({
  name: "wrong-text-workflow",
  version: "1.0.0",
  flow: [
    start(TestChat).returns(WorkflowStartTextDto).toAgent(ChattyAgent).toFinish(SummaryFinish),
  ],
})
class WrongTextWorkflow {}

describe("#270 AC10: an agent without input / output reads the message and answers with text", () => {
  star(
    "its reply is the finish's WorkflowFinishTextDto; it read the start's message",
    async ({ app, mockLlm }) => {
      mockLlm(TestMain).thenReturn(routeTo(Alpha));
      mockLlm(Alpha).thenReturn(replyWith("Hello back."));

      const result = await execute(app, TestChat, { text: "hello" });

      expect(result).toFollowPath([TestChat, TestMain, Alpha, TestAnswer]);
      expect(result).toFinishWith(TestAnswer, { text: "Hello back." });
      expect(mockLlm(Alpha).onlyRequest.input).toBe(
        '### message (from chat-workflow-start)\n{\n  "text": "hello"\n}',
      );
    },
  );

  it("[flow.text-agent-target]: a text agent leading elsewhere fails assembly", async () => {
    const error = await workflowOf(WrongTextWorkflow).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphRuleError);
    expect((error as GraphRuleError).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "flow.text-agent-target", nodes: ["chatty-agent"] }),
      ]),
    );
  });
});
