import { beforeEach, describe, expect, it } from "vitest";
import { toolCallFrameOf } from "../../../src/flow/context/frame.js";
import { idempotencyKeyOf } from "../../../src/flow/context/idempotency.js";
import { callTool, replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { testExecutionContext } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ContextStart,
  DraftDto,
  JudgedWriterAgent,
  NoteTool,
  PublishAction,
  ReviewRouter,
  WriterAgent,
  resetSeen,
  seen,
  ContextApplication,
  JudgedContextApplication,
} from "./fixtures/context.workflow.js";

beforeEach(resetSeen);

describe("#280 Q43: one idempotency key per operation", () => {
  it("a step: execution, node, visit", () => {
    expect(
      idempotencyKeyOf({ executionId: "exec-1", nodeId: "send-draft-action", visitNumber: 2 }),
    ).toBe("exec-1:send-draft-action:2");
  });

  it("a per-item step, a tool in an agent, a tool in a per-item agent", () => {
    const step = { executionId: "exec-1", visitNumber: 1 };

    expect(idempotencyKeyOf({ ...step, nodeId: "check-company-action", itemIndex: 36 })).toBe(
      "exec-1:check-company-action:1:36",
    );
    expect(idempotencyKeyOf({ ...step, nodeId: "payment-agent", callId: "call_7f3a" })).toBe(
      "exec-1:payment-agent:1:call_7f3a",
    );
    expect(
      idempotencyKeyOf({ ...step, nodeId: "research-agent", itemIndex: 36, callId: "call_7f3a" }),
    ).toBe("exec-1:research-agent:1:36:call_7f3a");
  });

  it("regression: a tool call's key keeps the item index of a per-item agent", () => {
    const agent = testExecutionContext({
      executionId: "exec-1",
      step: { component: WriterAgent, itemIndex: 36 },
    });
    const { executionId, threadId, ownerId, signal, workflow, tenant } = agent;

    const call = toolCallFrameOf(
      {
        execution: { executionId, threadId, ownerId, signal, workflow, tenant, values: {} },
        step: agent.step,
      },
      "call_1",
    );

    expect(call.step).toMatchObject({
      callId: "call_1",
      itemIndex: 36,
      idempotencyKey: "exec-1:writer-agent:1:36:call_1",
    });
  });
});

const loop = testWith(ContextApplication);
const judged = testWith(JudgedContextApplication);

describe("#280 AC7: the key differs on every pass of a cycle and every tool call", () => {
  loop(
    "each pass of the writer has its own visit number, each call its own key",
    async ({ app, mockLlm }) => {
      mockLlm(WriterAgent).thenReturn(
        callTool(NoteTool, { text: "first" }),
        replyWith(DraftDto, { text: "v1" }),
        callTool(NoteTool, { text: "second" }),
        replyWith(DraftDto, { text: "v2" }),
      );
      mockLlm(ReviewRouter).thenReturn(routeTo(WriterAgent), routeTo(PublishAction));

      const done = await execute(app, ContextStart, { text: "a post" });

      const [first, second] = seen.toolSteps;
      expect(seen.toolSteps.map((step) => step.visitNumber)).toEqual([1, 2]);
      expect(first?.idempotencyKey).toBe(`${done.runId}:writer-agent:1:${String(first?.callId)}`);
      expect(second?.idempotencyKey).toBe(`${done.runId}:writer-agent:2:${String(second?.callId)}`);
      expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
    },
  );
});

describe("#280 AC7: a retry keeps the visit number", () => {
  judged(
    "regression: a judge's retry runs in the same visit — visitNumber not increased",
    async ({ app, mockLlm }) => {
      mockLlm(JudgedWriterAgent).thenReturn(
        callTool(NoteTool, { text: "try 1" }),
        replyWith(DraftDto, { text: "v1" }),
        callTool(NoteTool, { text: "try 2" }),
        replyWith(DraftDto, { text: "v2" }),
      );

      await execute(app, ContextStart, { text: "a post" });

      expect(seen.judged).toEqual([
        "test/picky:judged-writer-agent:0",
        "test/picky:judged-writer-agent:1",
      ]);
      expect(seen.toolSteps.map((step) => step.visitNumber)).toEqual([1, 1]);
      expect(seen.toolSteps[0]?.callId).not.toBe(seen.toolSteps[1]?.callId);
    },
  );
});
