/**
 * A hand-written test dropped into the flow-patterns copy after the generators ran (#197, #489): the
 * generated agent is a real route of the generated workflow's main router, and the generated tool
 * is a real tool of that agent — run on the patterns' application, beside its own workflows.
 */
export const FLOW_PATTERNS_CHECK = `import { callTool, replyWith, routeTo, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { BillingAgent } from "../src/agents/billing/billing.agent.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { OnboardingMainRouter } from "../src/routers/onboarding-main/onboarding-main.router.js";
import { RefundTool } from "../src/tools/refund.tool.js";
import { TextWorkflowFinish } from "../src/workflows/onboarding/text.workflow-finish.js";
import { TextWorkflowStart } from "../src/workflows/onboarding/text.workflow-start.js";

const test = testWith(FlowPatternsApplication);

test("the generated agent is a route of the router and calls its generated tool", async ({
  app,
  mockLlm,
}) => {
  mockLlm(OnboardingMainRouter).thenReturn(routeTo(BillingAgent));
  mockLlm(BillingAgent).thenReturn(
    callTool(RefundTool, { query: "order 42" }),
    replyWith("Refunded."),
  );

  const result = await app.execute(TextWorkflowStart, { text: "refund order 42" });

  expect(result).toFollowPath([
    TextWorkflowStart,
    OnboardingMainRouter,
    BillingAgent,
    TextWorkflowFinish,
  ]);
  expect(result).toFinishWith(TextWorkflowFinish, { text: "Refunded." });
});
`;
