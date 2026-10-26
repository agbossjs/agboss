import { expect } from "vitest";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { HelplineAgent } from "../src/helpline/agents/helpline.agent.js";
import { PolicyFilesServer } from "../src/helpline/mcp/policy-files.server.js";
import { ReadPolicyTool } from "../src/helpline/mcp/read-policy.mcp.js";
import { HelplineAnswerWorkflowFinish } from "../src/helpline/workflow-finishes/helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "../src/helpline/workflow-starts/helpline.workflow-start.js";

/**
 * The helpline's MCP tool: the filesystem server is never started in a test — `mcpOf` answers its
 * tools.
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
