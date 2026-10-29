import { expect } from "vitest";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { DeskA2AAgent } from "../../../../src/helpline/a2a/desk.a2a-agent.js";
import { HelplineAgent } from "../../../../src/helpline/agents/helpline/helpline.agent.js";
import { AskDeskTool } from "../../../../src/helpline/tools/ask-desk.tool.js";
import { HelplineAnswerWorkflowFinish } from "../../../../src/helpline/workflows/helpline/helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "../../../../src/helpline/workflows/helpline/helpline.workflow-start.js";

/**
 * The helpline consumes the desk over A2A (#387, #398) through the declared contract
 * `DeskA2AAgent` — replaced here by `mockOf`; the desk's side is in
 * tests/desk/a2a/desk.a2a-expose.test.ts.
 */

const test = testWith(FlowPatternsApplication);

test("the helpline's tool calls the desk through its contract", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  const deskAgent = mockOf(DeskA2AAgent); // the remote application, replaced before the app starts
  deskAgent.execute.mockResolvedValue({ text: "Order 7 shipped on Monday." });
  mockLlm(HelplineAgent).thenReturn(
    callTool(AskDeskTool, { customerId: "c-1", question: "Where is #7?" }),
    replyWith("The desk says order 7 shipped on Monday."),
  );

  const result = await app.execute(HelplineWorkflowStart, { text: "c-1: where is #7?" });

  expect(result).toHaveToolCallMatching(AskDeskTool, { customerId: "c-1" });
  const calls = deskAgent.execute.mock.calls;
  expect(calls.map(([sent]) => sent)).toEqual([{ customerId: "c-1", question: "Where is #7?" }]);
  expect(calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal); // the tool call's: cancel, timeout
  expect(result).toFinishWith(HelplineAnswerWorkflowFinish, {
    text: "The desk says order 7 shipped on Monday.",
  });
});
