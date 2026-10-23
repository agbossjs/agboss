import { describe, expect } from "vitest";
import { GuardrailBlockedError, ToolBlockedError, ToolCallStatus, toolCallsOf } from "agboss";
import { callTool, callToolWithInvalidArguments, replyWith, testWith } from "agboss/testing";
import { DeskAgent } from "../src/desk/agents/desk.agent.js";
import { CloseAccountTool } from "../src/desk/tools/close-account.tool.js";
import { OrderStatusTool } from "../src/desk/tools/order-status.tool.js";
import { DeskAnswerWorkflowFinish } from "../src/desk/workflow-finishes/desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "../src/desk/workflow-starts/desk.workflow-start.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";

/**
 * The extension points around one agent (#382–#385): its code guardrails, its tool interceptor and
 * the workflow's custom compaction — scripted, so the transport provider is never called here.
 */

const test = testWith(FlowPatternsApplication);

const ask = (question: string) => ({ customerId: "c-1", question });

describe("the desk's trajectory, asserted as invariants", () => {
  test("a lookup, its internal note cut by the interceptor; no account closed", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(
      callTool(OrderStatusTool, { orderId: "7" }),
      replyWith("Order 7 shipped on Monday."),
    );

    const result = await app.execute(DeskWorkflowStart, ask("Where is order #7?"));

    expect(result).toFollowPath([DeskWorkflowStart, DeskAgent, DeskAnswerWorkflowFinish]);
    expect(result).toFinishWith(DeskAnswerWorkflowFinish, { text: "Order 7 shipped on Monday." });
    expect(result).toHaveCalledTools([OrderStatusTool]);
    expect(result).not.toHaveCalledTools([CloseAccountTool]);
    expect(result).toHaveToolCallMatching(OrderStatusTool, { orderId: "7" });
    const [lookup] = toolCallsOf(OrderStatusTool, result.toolCalls);
    expect(lookup?.status === ToolCallStatus.Succeeded && lookup.output).toEqual({
      status: "order 7 shipped on Monday",
    });
  });

  test("an archived order is answered by the interceptor, not the tool; the model goes on", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(
      callTool(OrderStatusTool, { orderId: "A-12" }),
      replyWith("That order is archived — do you have a recent one?"),
    );

    const result = await app.execute(DeskWorkflowStart, ask("Where is order #A-12?"));

    expect(toolCallsOf(OrderStatusTool, result.toolCalls).map((call) => call.status)).toEqual([
      ToolCallStatus.Replied,
    ]);
    expect(result).toFinishWith(DeskAnswerWorkflowFinish);
  });

  test("invalid arguments are refused before the tool, and the model tries again", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(
      callToolWithInvalidArguments(OrderStatusTool, { orderId: 7 }),
      callTool(OrderStatusTool, { orderId: "7" }),
      replyWith("Order 7 shipped on Monday."),
    );

    const result = await app.execute(DeskWorkflowStart, ask("Where is order #7?"));

    expect(toolCallsOf(OrderStatusTool, result.toolCalls).map((call) => call.status)).toEqual([
      ToolCallStatus.InvalidArguments,
      ToolCallStatus.Succeeded,
    ]);
  });
});

describe("what the desk refuses", () => {
  test("closing an account: the interceptor blocks it and the step fails", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(callTool(CloseAccountTool, { customerId: "c-1" }));

    await expect(app.execute(DeskWorkflowStart, ask("Close my account"))).rejects.toFailWith(
      ToolBlockedError,
      { interceptor: "desk-audit-tool-interceptor" },
    );
  });

  test("credentials in the question: blocked before any model call", async ({ app }) => {
    await expect(
      app.execute(DeskWorkflowStart, ask("My password is hunter2, where is #7?")),
    ).rejects.toFailWith(GuardrailBlockedError, {
      refusal: "Please never send passwords or card codes to the help desk.",
    });
  });

  test("a promised date in the answer: blocked as it leaves the agent", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(replyWith("We guarantee delivery on Friday."));

    await expect(app.execute(DeskWorkflowStart, ask("When will #7 arrive?"))).rejects.toFailWith(
      GuardrailBlockedError,
      { refusal: "We will follow up with a confirmed delivery date." },
    );
  });
});

test("past the two-turn window, older turns become case notes (a custom compaction)", async ({
  app,
  mockLlm,
}) => {
  const threadId = "desk-thread";
  mockLlm(DeskAgent).thenReturn(
    ...[1, 2, 3, 4].map((turn) => replyWith(`Answer ${String(turn)}.`)),
  );

  const results = [];
  for (const turn of [1, 2, 3, 4])
    results.push(
      await app.execute(DeskWorkflowStart, ask(`Question ${String(turn)}`), { threadId }),
    );

  expect(results.slice(0, 3).map((result) => result.compacted ?? [])).toEqual([[], [], []]);
  expect(results[3]?.compacted).toHaveLength(1);
});
