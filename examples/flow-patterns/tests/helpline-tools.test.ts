import { expect } from "vitest";
import { callTool, replyWith, testWith } from "agboss/testing";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { HelplineAgent } from "../src/helpline/agents/helpline.agent.js";
import { PolicyFilesServer } from "../src/helpline/mcp/policy-files.server.js";
import { ReadPolicyTool } from "../src/helpline/mcp/read-policy.mcp.js";
import { HelplineAnswerWorkflowFinish } from "../src/helpline/workflow-finishes/helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "../src/helpline/workflow-starts/helpline.workflow-start.js";

/**
 * The helpline's MCP tool and its memory: the filesystem server is never started in a test —
 * `mcpOf` answers its tools — and the agent's own memory strategy chooses the turns it sees.
 */

const test = testWith(FlowPatternsApplication);

test("the policy is read through the MCP server's read_text_file", async ({
  app,
  mockLlm,
  mcpOf,
}) => {
  const paths: string[] = [];
  mcpOf(PolicyFilesServer).thenReturn({
    read_text_file: ({ path }: { path: string }) => {
      paths.push(path);
      return Promise.resolve({ content: "Returns within 30 days of delivery." });
    },
  });
  mockLlm(HelplineAgent).thenReturn(
    callTool(ReadPolicyTool, { topic: "returns" }),
    replyWith("You can return it within 30 days."),
  );

  const result = await app.execute(HelplineWorkflowStart, { text: "c-1: can I return #7?" });

  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatch(/data[/\\]policies[/\\]returns\.md$/u);
  expect(result).toHaveToolCallMatching(ReadPolicyTool, { topic: "returns" });
  expect(result).toFinishWith(HelplineAnswerWorkflowFinish, {
    text: "You can return it within 30 days.",
  });
});

test("the agent remembers only the thread's turns about the order it is asked about", async ({
  app,
  mockLlm,
}) => {
  mockLlm(HelplineAgent).thenReturn(
    replyWith("Order 7 shipped."),
    replyWith("Order 9 is late."),
    replyWith("Still on its way."),
  );
  const thread = { threadId: "caller-1" };

  await app.execute(HelplineWorkflowStart, { text: "c-1: where is #7?" }, thread);
  await app.execute(HelplineWorkflowStart, { text: "c-1: and #9?" }, thread);
  await app.execute(HelplineWorkflowStart, { text: "c-1: back to #7, any news?" }, thread);

  const request = mockLlm(HelplineAgent).lastRequest;
  const seen = JSON.stringify(request.kind === "chat" ? request.messages : request.input);
  expect(seen).toContain("Order 7 shipped.");
  expect(seen).not.toContain("Order 9 is late.");
});
