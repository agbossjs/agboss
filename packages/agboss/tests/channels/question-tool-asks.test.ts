/**
 * #712: the model's arguments to a question call are the question a person or a system reads — so
 * they are validated as the role's `ask` (strictly: no field it does not declare) before anything is
 * asked. Invalid arguments ask nobody: no pause, no channel send; the model reads a tool error and
 * may try again, and the call counts against the role's `maxVisits`.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { VisitsLimitExceededError } from "../../src/flow/runtime/errors.js";
import { PausedExecutionRepository } from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import {
  ApproverQuestion,
  BuyerAgent,
  BuyerDesk,
  BuyerWorkflowFinish,
  BuyerWorkflowStart,
  QuestionToolsApplication,
} from "../flow/fixtures/question-tools.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(QuestionToolsApplication);
const asking = { threadId: "buy-1", ownerId: "alice" };

/** What the model read as the results of its tool calls, in order. */
const toolResultsOf = (request: ModelRequest | undefined): readonly string[] =>
  request?.kind === "chat"
    ? request.messages
        .filter((line) => line.role === "tool")
        .map((line) => (typeof line.text === "string" ? line.text : JSON.stringify(line.text)))
    : [];

/** Arguments the generated types refuse: what a model may send anyway. */
const malformed = (args: Readonly<Record<string, unknown>>): never => args as never;

const INVALID_ASKS = [
  ["a field the ask does not declare", { item: "laptop", priceUsd: 900, bankAccount: "DE89" }],
  ["a field of the wrong type", { item: "laptop", priceUsd: "nine hundred" }],
  ["a required field missing", { item: "laptop" }],
] as const;

describe("#712: invalid question arguments ask nobody", () => {
  for (const [what, args] of INVALID_ASKS) {
    test(`${what}: no pause, no send, the model reads a tool error and goes on`, async ({
      app,
      mockLlm,
    }) => {
      mockLlm(BuyerAgent).thenReturn(
        callTool(ApproverQuestion, malformed(args)),
        replyWith("could not ask"),
      );

      const done = await execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking);

      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(done).toFinishWith(BuyerWorkflowFinish, { text: "could not ask" });
      expect(app.resolve(BuyerDesk).asked).toEqual([]);
      const pauses = await app
        .resolve(PausedExecutionRepository)
        .findAllByTenantIdAndRootExecutionId("default", done.executionId);
      expect(pauses).toEqual([]);
      const [, afterCall] = mockLlm(BuyerAgent).requests;
      const [result = ""] = toolResultsOf(afterCall);
      expect(result).toMatch(/^Tool error: /);
      expect(result).not.toContain("DE89");
      expect(done.toolCalls[0]?.status).toBe("invalid-arguments");
    });
  }

  test("invalid calls count against maxVisits: the next valid one is past it, asked of nobody", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(
      callTool(ApproverQuestion, malformed({ item: "laptop" })),
      callTool(ApproverQuestion, malformed({ item: "laptop", priceUsd: "a lot" })),
      callTool(ApproverQuestion, { item: "laptop", priceUsd: 900 }),
    );

    await expect(
      execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking),
    ).rejects.toBeInstanceOf(VisitsLimitExceededError);
    expect(app.resolve(BuyerDesk).asked).toEqual([]);
  });
});
