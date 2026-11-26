/**
 * #712 AC1 / AC2 / AC3: an agent asks a question role through its tool loop — the model calls the
 * role like a tool (input = the role's ask), the loop pauses on the role's channel, and the typed
 * answer comes back to the model as the call's result.
 */
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseStatus, PausedExecutionRepository, ValidationError } from "../../src/index.js";
import { PauseKind } from "../../src/pause/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import {
  BuyerAgent,
  BuyerDesk,
  BuyerWorkflowFinish,
  BuyerWorkflowStart,
  ApproverExternalTask,
  OrderTool,
  QuestionToolsApplication,
  RuleQuestionToolsApplication,
} from "../flow/fixtures/question-tools.fixture.js";
import { answerOf, execute } from "../helpers/flow.js";

const test = testWith(QuestionToolsApplication);
const ruled = testWith(RuleQuestionToolsApplication);

const owner = { ownerId: "alice" };
const asking = { threadId: "buy-1", ownerId: "alice" };
const laptop = { item: "laptop", priceUsd: 900, requester: "alice@example.com" };

/** What the model read as the results of its tool calls, in order. */
const toolResultsOf = (request: ModelRequest | undefined): readonly string[] =>
  request?.kind === "chat"
    ? request.messages
        .filter((line) => line.role === "tool")
        .map((line) => (typeof line.text === "string" ? line.text : JSON.stringify(line.text)))
    : [];

describe("#712 AC1 / AC2: the agent's question call pauses like any pause", () => {
  test("AC2: result.pending lists the question with its masked ask; nothing else ran", async ({
    app,
    mockModel,
  }) => {
    mockModel(BuyerAgent).thenReturn(callTool(ApproverExternalTask, laptop));

    const paused = await execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toEqual([
      {
        kind: PauseKind.ExternalTask,
        pauseId: expect.any(String),
        respondent: "owner",
        step: "buyer-agent",
        target: "approver-external-task",
        channel: "desk-approver-channel",
        expiresAt: expect.any(Date),
        childExecutionId: undefined,
        itemIndex: undefined,
        // the requester is `sensitive`: masked in the record, the channel's ask and the result
        input: { item: "laptop", priceUsd: 900, requester: expect.not.stringContaining("alice") },
        trail: [expect.objectContaining({ action: "opened" })],
      },
    ]);
    const desk = app.resolve(BuyerDesk);
    expect(desk.asked).toEqual([
      expect.objectContaining({
        pauseId: paused.pending[0]?.pauseId,
        input: paused.pending[0]?.input,
      }),
    ]);
    const pause = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", paused.pending[0]?.pauseId ?? "");
    expect(pause).toMatchObject({
      status: PauseStatus.Pending,
      isSent: true,
      kind: PauseKind.ExternalTask,
      step: "buyer-agent",
      component: { name: "approver-external-task", kind: "external-task" },
    });
  });

  test("AC1 / AC3: the typed answer is the call's result; the model orders within it", async ({
    app,
    mockModel,
  }) => {
    mockModel(BuyerAgent).thenReturn(
      callTool(ApproverExternalTask, laptop),
      callTool(OrderTool, { item: "laptop", limitUsd: 950 }),
      replyWith("ordered within 950"),
    );
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking);

    const done = await app.resume(
      answerOf(paused, { approved: true, limitUsd: 950, approverEmail: "bob@example.com" }),
      owner,
    );

    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "ordered within 950" });
    const [, afterAnswer] = mockModel(BuyerAgent).requests;
    const [result = ""] = toolResultsOf(afterAnswer);
    expect(JSON.parse(result)).toMatchObject({ approved: true, limitUsd: 950 });
    // the approver's e-mail is `sensitive` in the answer DTO: the model reads it masked
    expect(result).not.toContain("bob@example.com");
    expect(app.resolve(BuyerDesk).ordered).toEqual([{ item: "laptop", limitUsd: 950 }]);
    // the question call is recorded as the role (kind question), its output the answer
    expect(done.toolCalls.map((call) => call.step.component)).toMatchObject([
      { name: "approver-external-task", kind: "external-task" },
      { name: "order-tool", kind: "tool" },
    ]);
    expect(done.toolCalls[0]?.output).toMatchObject({ approved: true, limitUsd: 950 });
  });

  ruled(
    "AC2: a channel's decided(answer) goes on at once, nothing pending",
    async ({ app, mockModel }) => {
      mockModel(BuyerAgent).thenReturn(
        callTool(ApproverExternalTask, { item: "mouse", priceUsd: 40 }),
        replyWith("approved up to 100"),
      );

      const done = await execute(app, BuyerWorkflowStart, { text: "buy a mouse" }, asking);

      expect(done).toFinishWith(BuyerWorkflowFinish, { text: "approved up to 100" });
      const [, afterAnswer] = mockModel(BuyerAgent).requests;
      expect(JSON.parse(toolResultsOf(afterAnswer)[0] ?? "")).toEqual({
        approved: true,
        limitUsd: 100,
      });
    },
  );
});

describe("#712 AC3: the answer is validated as the role's answer DTO", () => {
  test("AC3: an invalid decision is ValidationError.DtoInvalid and the pause stays pending", async ({
    app,
    mockModel,
  }) => {
    mockModel(BuyerAgent).thenReturn(callTool(ApproverExternalTask, laptop), replyWith("ordered"));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await expect(
      app.resume({ pauseId, decision: { approved: true } }, owner),
    ).rejects.toBeInstanceOf(ValidationError.DtoInvalid);
    await expect(
      app.resume({ pauseId, decision: { approved: true, limitUsd: -1 } }, owner),
    ).rejects.toBeInstanceOf(ValidationError.DtoInvalid);

    const pause = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(pause?.status).toBe(PauseStatus.Pending);
    const done = await app.resume({ pauseId, decision: { approved: false, limitUsd: 0 } }, owner);
    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "ordered" });
  });

  test("AC3: a reply read by the interpreter resumes; one it does not understand keeps it pending", async ({
    app,
    mockModel,
  }) => {
    mockModel(BuyerAgent).thenReturn(callTool(ApproverExternalTask, laptop), replyWith("declined"));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy a laptop" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await expect(app.resume({ pauseId, reply: "🤷" }, owner)).rejects.toBeInstanceOf(
      PauseError.UninterpretableReply,
    );
    const pending = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(pending?.status).toBe(PauseStatus.Pending);

    const done = await app.resume({ pauseId, reply: "no, not now" }, owner);
    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "declined" });
    const [, afterAnswer] = mockModel(BuyerAgent).requests;
    expect(JSON.parse(toolResultsOf(afterAnswer)[0] ?? "")).toEqual({
      approved: false,
      limitUsd: 0,
    });
  });
});
