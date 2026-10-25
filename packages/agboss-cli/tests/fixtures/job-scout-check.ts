/**
 * A hand-written test dropped into the job-scout copy after the generators ran (#197): the generated
 * agent is a real route of the main router, and the generated tool is a real tool of that agent.
 */
export const JOB_SCOUT_CHECK = `import { callTool, replyWith, routeTo, testWith } from "agboss/testing";
import { expect } from "vitest";
import { BillingAgent } from "../src/agents/billing/billing.agent.js";
import { JobScoutApplication } from "../src/job-scout.application.js";
import { MainRouter } from "../src/routers/main.router.js";
import { RefundTool } from "../src/tools/refund.tool.js";
import { ChatWorkflowFinish } from "../src/workflow-finishes/chat.workflow-finish.js";
import { ChatWorkflowStart } from "../src/workflow-starts/chat.workflow-start.js";

const test = testWith(JobScoutApplication);

test("the generated agent is a route of the router and calls its generated tool", async ({
  app,
  mockLlm,
}) => {
  mockLlm(MainRouter).thenReturn(routeTo(BillingAgent));
  mockLlm(BillingAgent).thenReturn(
    callTool(RefundTool, { query: "order 42" }),
    replyWith("Refunded."),
  );

  const result = await app.execute(ChatWorkflowStart, { text: "refund order 42" });

  expect(result).toFollowPath([ChatWorkflowStart, MainRouter, BillingAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, { text: "Refunded." });
});
`;
