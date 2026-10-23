/**
 * #395 PR 3: the model's invalid turns, scripted — `callToolWithInvalidArguments`,
 * `callToolWithTruncatedArguments` (both recorded `ToolCallStatus.InvalidArguments`, counted in the
 * step's `validationAttempts`, the tool never runs) and `replyWithInvalidAnswer` (an invalid answer:
 * the third fails the step with `AgentAnswerInvalidError`).
 */
import { describe, expect } from "vitest";
import { AgentAnswerInvalidError, ToolCallStatus } from "../../src/index.js";
import {
  callTool,
  callToolWithInvalidArguments,
  callToolWithTruncatedArguments,
  replyWith,
  replyWithInvalidAnswer,
  routeTo,
  testWith,
} from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ClerkAgent,
  ClerkStart,
  LookupOrderTool,
  TrajectoryApplication,
} from "../app/fixtures/trajectory.workflow.js";
import {
  DoneFinish,
  DraftDto,
  EditApplication,
  EditorAgent,
  EditStart,
  GateRouter,
} from "../flow/runtime/fixtures/edit.workflow.js";

const clerk = testWith(TrajectoryApplication);
const edit = testWith(EditApplication);

describe("callToolWithInvalidArguments", () => {
  clerk(
    "the tool never runs; the call is recorded and the model retries",
    async ({ app, mockLlm }) => {
      mockLlm(ClerkAgent).thenReturn(
        callToolWithInvalidArguments(LookupOrderTool, { orderId: 7 }),
        callTool(LookupOrderTool, { orderId: "7" }),
        replyWith("Order 7 has shipped."),
      );

      const result = await execute(app, ClerkStart, { text: "where is 7?" });

      expect(result.toolCalls.map((call) => [call.input, call.status])).toEqual([
        [{ orderId: 7 }, ToolCallStatus.InvalidArguments],
        [{ orderId: "7" }, ToolCallStatus.Succeeded],
      ]);
      expect(result.toolCalls[1]?.step.validationAttempts).toBe(1);
      expect(JSON.stringify(mockLlm(ClerkAgent).requests[1])).toContain("orderId");
      expect(mockLlm(ClerkAgent)).toHaveScriptedToolCalls([LookupOrderTool, LookupOrderTool]);
    },
  );
});

describe("callToolWithTruncatedArguments", () => {
  clerk("the arguments are cut JSON: no run, the model reads why", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callToolWithTruncatedArguments(LookupOrderTool, { orderId: "7" }),
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where is 7?" });

    const [cut, retried] = result.toolCalls;
    expect(cut).toMatchObject({ input: '{"orderId":"7', status: ToolCallStatus.InvalidArguments });
    expect(retried).toMatchObject({ status: ToolCallStatus.Succeeded });
    expect(retried?.step.validationAttempts).toBe(1);
    expect(JSON.stringify(mockLlm(ClerkAgent).requests[1])).toContain("not valid JSON");
  });
});

describe("both kinds in one visit", () => {
  clerk("each counts in validationAttempts of the calls after it", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callToolWithInvalidArguments(LookupOrderTool, { orderId: 7 }),
      callToolWithTruncatedArguments(LookupOrderTool, { orderId: "7" }),
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where is 7?" });

    expect(result.toolCalls.at(-1)?.step.validationAttempts).toBe(2);
  });
});

describe("replyWithInvalidAnswer", () => {
  edit("an invalid answer goes back to the model; the retry answers", async ({ app, mockLlm }) => {
    mockLlm(EditorAgent).thenReturn(
      replyWithInvalidAnswer(DraftDto, { body: "no text field" }),
      replyWith(DraftDto, { text: "v1" }),
    );
    mockLlm(GateRouter).thenReturn(routeTo(DoneFinish));

    const result = await execute(app, EditStart, { text: "a poem" });

    expect(result).toFinishWith(DoneFinish, { text: "v1" });
    expect(mockLlm(EditorAgent).requests).toHaveLength(2);
  });

  edit("the third invalid answer fails the step", async ({ app, mockLlm }) => {
    const invalid = replyWithInvalidAnswer(DraftDto, { body: "no text field" });
    mockLlm(EditorAgent).thenReturn(invalid, invalid, invalid);

    await expect(execute(app, EditStart, { text: "a poem" })).rejects.toFailWith(
      AgentAnswerInvalidError,
      { code: "step.agent.invalid-answer" },
    );
  });
});
