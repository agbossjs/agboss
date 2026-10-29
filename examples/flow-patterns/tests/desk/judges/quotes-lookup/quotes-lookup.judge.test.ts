import { expect } from "vitest";
import { PlainTextDto } from "@agboss/core/dto";
import { callTool, replyWith, testJudge, testWith } from "@agboss/core/testing";
import { DeskAgent } from "../../../../src/desk/agents/desk/desk.agent.js";
import { QuotesLookupJudge } from "../../../../src/desk/judges/quotes-lookup/quotes-lookup.judge.js";
import { OrderStatusTool } from "../../../../src/desk/tools/order-status.tool.js";
import { DeskWorkflowStart } from "../../../../src/desk/workflows/desk/desk.workflow-start.js";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";

const test = testWith(FlowPatternsApplication);

test("testJudge: a code judge on the tool calls of a real (scripted) visit", async ({
  app,
  mockLlm,
}) => {
  mockLlm(DeskAgent).thenReturn(
    callTool(OrderStatusTool, { orderId: "7" }),
    replyWith("Order 7 shipped."),
  );
  const { toolCalls } = await app.execute(DeskWorkflowStart, {
    customerId: "c-1",
    question: "Where is #7?",
  });
  const runJudge = testJudge(QuotesLookupJudge);

  const named = await runJudge({
    variant: PlainTextDto,
    reply: { text: "Order 7 shipped." },
    task: "Answer",
    attempt: 0,
    toolCalls,
  });
  const vague = await runJudge({
    variant: PlainTextDto,
    reply: { text: "It shipped." },
    task: "Answer",
    attempt: 0,
    toolCalls,
  });

  expect(named.output).toMatchObject({ passed: true, metrics: { lookups: 1 } });
  expect(vague.output).toMatchObject({
    passed: false,
    reason: "name the order you looked up in the answer",
  });
  expect(named.spend.totalUsd).toBe(0);
});
