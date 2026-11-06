/**
 * #808 AC3, AC4: what a message asks — the skill it names (`metadata[skills-uri].skill`, optional
 * with one), its input checked before anything is kept (`-32602`, a file part `-32005`), its context;
 * a paused execution is `INPUT_REQUIRED` with the pauses its caller may answer, a follow-up with the
 * same `taskId` resumes it (a `data` decision, a text reply), a pause not pending on the task is
 * `-32602`, a channel-only pause is `WORKING` "awaiting <channel> out of band".
 */
import { beforeEach, describe, expect } from "vitest";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { A2ATaskRepository } from "../../../src/infrastructure/a2a-task.repository.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import {
  AuditCheckAgent,
  AuditRefundAgent,
  BatchSummaryDto,
  ConfirmOrderTool,
  DeskClerkAgent,
  RefundDoneDto,
  RefundTool,
  resetPauses,
  seen,
} from "../../channels/fixtures/pauses.workflow.js";
import { BearerCallerResolver, resetAsked } from "../fixtures/bearer-caller-resolver.js";
import { DeskA2AExpose, ServedPausesApplication } from "../fixtures/served-pauses.application.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { data, errorInfoOf, errorOf, rpc, text, userMessage, type RpcAnswer } from "./rpc.js";
import { dataMessage } from "./sdk-client.js";

const test = testWith(ServedPausesApplication);
const listener = { expose: DeskA2AExpose, callerResolver: BearerCallerResolver };
const DESK = { [A2A_SKILLS_EXTENSION]: { skill: "desk-workflow-start" } };
const AUDIT = { [A2A_SKILLS_EXTENSION]: { skill: "audit-workflow-start" } };

beforeEach(() => {
  resetPauses();
  resetAsked();
});

interface WireTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: {
    readonly state: string;
    readonly message?: { parts: Record<string, unknown>[] };
  };
  readonly artifacts?: readonly { name: string; parts: Record<string, unknown>[] }[];
}

const taskOf = (answer: RpcAnswer): WireTask => {
  const result = answer.body.result as { task?: WireTask } | WireTask | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(answer.body)}`);
  return "task" in result && result.task !== undefined ? result.task : (result as WireTask);
};

const keptTasks = async (app: {
  resolve: (token: typeof A2ATaskRepository) => A2ATaskRepository;
}) =>
  (
    await app
      .resolve(A2ATaskRepository)
      .list({ tenantId: "default", ownerId: "dana", pageSize: 50 })
  ).tasks;

describe("#808: the skill and the input of a new message", () => {
  test("with several skills a message names one; none or an unknown one is -32602 listing them, nothing kept", async ({
    a2aServer,
    app,
  }) => {
    const { url } = await a2aServer(listener);

    const unnamed = await rpc(url, "SendMessage", { message: userMessage("m-1", [text("hi")]) });
    const unknown = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [text("hi")], {
        metadata: { [A2A_SKILLS_EXTENSION]: { skill: "nope" } },
      }),
    });

    expect(errorOf(unnamed).code).toBe(-32602);
    expect(errorInfoOf(unnamed)).toEqual({
      code: "a2a.skill-required",
      skills: "desk-workflow-start,audit-workflow-start",
    });
    expect(errorInfoOf(unknown)?.code).toBe("a2a.unknown-skill");
    expect(await keptTasks(app)).toEqual([]);
  });

  test("a DTO skill takes one data part, checked: an invalid one is -32602 with the schema, nothing run", async ({
    a2aServer,
    app,
    mockLlm,
  }) => {
    mockLlm(AuditRefundAgent).thenReturn(replyWith(RefundDoneDto, { orderId: "7" }));
    mockLlm(AuditCheckAgent).thenReturn(replyWith(BatchSummaryDto, { text: "ok" }));
    const { url } = await a2aServer(listener);

    const invalid = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [data({ orderId: 7 })], { metadata: AUDIT }),
    });
    const asText = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [text("refund 7")], { metadata: AUDIT }),
    });
    const valid = await rpc(url, "SendMessage", {
      message: userMessage("m-3", [data({ orderId: "7" })], { metadata: AUDIT }),
    });

    expect(errorInfoOf(invalid)).toMatchObject({
      code: "dto.invalid",
      skill: "audit-workflow-start",
      fields: "orderId",
    });
    expect(JSON.parse(errorInfoOf(invalid)?.inputSchema ?? "{}")).toMatchObject({ type: "object" });
    expect(errorInfoOf(asText)?.code).toBe("a2a.input-shape");
    expect(taskOf(valid)).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ name: "audit-workflow-finish", parts: [{ data: { text: "7: ok" } }] }],
    });
    expect((await keptTasks(app)).length).toBe(1);
  });

  test("a text skill answers its text finish as a text part", async ({ a2aServer, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(replyWith("Hello."));
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("hi")], { metadata: DESK }),
    });

    expect(taskOf(answer).artifacts).toEqual([
      expect.objectContaining({
        name: "desk-workflow-finish",
        parts: [{ text: "Hello.", mediaType: "text/plain" }],
      }),
    ]);
  });

  test("a file part is -32005", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", {
      message: userMessage(
        "m-1",
        [{ url: "https://files.example/a.pdf", mediaType: "application/pdf" }],
        {
          metadata: DESK,
        },
      ),
    });

    expect(errorOf(answer).code).toBe(-32005);
  });

  test("the client's contextId is the task's; a bad one is -32602, never replaced", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(replyWith("Hello."));
    const { url } = await a2aServer(listener);

    const own = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("hi")], { metadata: DESK, contextId: "ctx-dana-1" }),
    });
    const bad = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [text("hi")], { metadata: DESK, contextId: "x\u0000y" }),
    });

    expect(taskOf(own).contextId).toBe("ctx-dana-1");
    expect(errorInfoOf(bad)).toMatchObject({ code: "a2a.invalid-id", field: "contextId" });
  });
});

describe("#808: a start the app refuses", () => {
  test("another owner's context: FAILED at once with the refusal's code, no execution", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(replyWith("Hello."));
    const { url } = await a2aServer(listener);
    const message = (messageId: string) =>
      userMessage(messageId, [text("hi")], { metadata: DESK, contextId: "ctx-eve" });
    await rpc(url, "SendMessage", { message: message("m-eve") }, { owner: "eve" });

    const refused = taskOf(await rpc(url, "SendMessage", { message: message("m-dana") }));

    expect(refused.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "the task failed: run.thread-owner" }] },
    });
    expect(mockLlm(DeskClerkAgent)).toHaveBeenCalledTimes(1);
  });
});

describe("#808 AC4: pauses and follow-ups", () => {
  test("a pause its caller answers → INPUT_REQUIRED with it; a data decision with the taskId resumes it", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(ConfirmOrderTool, { orderId: "7" }),
      replyWith("Confirmed."),
    );
    const { url } = await a2aServer(listener);

    const paused = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("confirm 7")], { metadata: DESK }),
      }),
    );
    const [pause] = seen.confirmations;
    const resumed = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-2", [data({ decision: { approved: true } })], {
          taskId: paused.id,
        }),
      }),
    );

    expect(paused.status).toMatchObject({
      state: "TASK_STATE_INPUT_REQUIRED",
      message: {
        role: "ROLE_AGENT",
        parts: [{ data: { pauses: [{ pauseId: pause?.pauseId, kind: "approval" }] } }],
      },
    });
    expect(resumed).toMatchObject({ id: paused.id, status: { state: "TASK_STATE_COMPLETED" } });
    expect(seen.confirmed).toEqual(["7"]);
  });

  test("a resend of the follow-up replays it; a pause not pending on the task is -32602", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(ConfirmOrderTool, { orderId: "7" }),
      replyWith("Confirmed."),
    );
    const { url } = await a2aServer(listener);
    const paused = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("confirm 7")], { metadata: DESK }),
      }),
    );

    const other = await rpc(url, "SendMessage", {
      message: userMessage(
        "m-2",
        [data({ pauseId: "another-task-pause", decision: { approved: true } })],
        {
          taskId: paused.id,
        },
      ),
    });
    const answer = {
      message: userMessage("m-3", [data({ decision: { approved: true } })], { taskId: paused.id }),
    };
    const first = taskOf(await rpc(url, "SendMessage", answer));
    const again = taskOf(await rpc(url, "SendMessage", answer));
    const late = await rpc(url, "SendMessage", {
      message: userMessage("m-4", [data({ decision: { approved: false } })], { taskId: paused.id }),
    });

    expect(errorInfoOf(other)?.code).toBe("a2a.unknown-pause");
    expect(first.status.state).toBe("TASK_STATE_COMPLETED");
    expect(again).toMatchObject({ id: paused.id, status: { state: "TASK_STATE_COMPLETED" } });
    expect(errorOf(late).code).toBe(-32004);
    expect(seen.confirmed).toEqual(["7"]);
  });

  test("a text reply without the role's interpreter is -32602; the pause stays pending", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
    const { url } = await a2aServer(listener);
    const paused = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("confirm 7")], { metadata: DESK }),
      }),
    );

    const reply = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [text("yes")], { taskId: paused.id }),
    });
    const after = taskOf(await rpc(url, "GetTask", { id: paused.id }));

    expect(errorOf(reply).code).toBe(-32602);
    expect(errorInfoOf(reply)?.code).toBe("a2a.reply-not-understood");
    expect(after.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  test("a channel-only pause → WORKING, awaiting its channel out of band; a follow-up is -32004", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    const { url } = await a2aServer(listener);

    const sent = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("refund 7")], { metadata: DESK }),
        configuration: { returnImmediately: true },
      }),
    );
    const read = async () => taskOf(await rpc(url, "GetTask", { id: sent.id }));
    let waiting = await read();
    for (let tries = 0; waiting.status.message === undefined && tries < 200; tries += 1)
      waiting = await read();
    const followUp = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [data({ decision: { approved: true } })], { taskId: sent.id }),
    });

    expect(waiting.status).toEqual({
      state: "TASK_STATE_WORKING",
      message: expect.objectContaining({
        parts: [{ text: "awaiting refund-approval-channel out of band", mediaType: "text/plain" }],
      }) as object,
      timestamp: expect.any(String) as string,
    });
    expect(errorOf(followUp).code).toBe(-32004);
  });

  test("an unknown taskId, or another caller's task, is -32001; a contextId not the task's -32602", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
    const { url } = await a2aServer(listener);
    const paused = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("confirm 7")], { metadata: DESK }),
      }),
    );
    const answer = (fields: { taskId: string; contextId?: string }) =>
      userMessage("m-2", [data({ decision: { approved: true } })], fields);

    const unknown = await rpc(url, "SendMessage", { message: answer({ taskId: "no-such-task" }) });
    const others = await rpc(
      url,
      "SendMessage",
      { message: answer({ taskId: paused.id }) },
      { owner: "eve" },
    );
    const othersRead = await rpc(url, "GetTask", { id: paused.id }, { owner: "eve" });
    const mismatch = await rpc(url, "SendMessage", {
      message: answer({ taskId: paused.id, contextId: "other-ctx" }),
    });

    expect(errorOf(unknown).code).toBe(-32001);
    expect(errorOf(others).code).toBe(-32001);
    expect(errorOf(othersRead).code).toBe(-32001);
    expect(errorInfoOf(mismatch)?.code).toBe("a2a.context-mismatch");
    expect(seen.confirmed).toEqual([]);
  });
});

describe("#808 (review): a follow-up resend whose first outcome was lost", () => {
  test("is decided again, never told accepted: its pause still waits → resumed, once", async ({
    a2aServer,
    app,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(ConfirmOrderTool, { orderId: "7" }),
      replyWith("Confirmed."),
    );
    const { url } = await a2aServer(listener);
    const paused = taskOf(
      await rpc(url, "SendMessage", {
        message: userMessage("m-1", [text("confirm 7")], { metadata: DESK }),
      }),
    );
    const decision = { decision: { approved: true } };
    // the first attempt kept its message, then the store failed before its outcome was kept
    await app.resolve(A2ATaskRepository).saveMessageIfAbsent({
      tenantId: "default",
      ownerId: "dana",
      messageId: "m-2",
      requestHash: requestHashOf(
        "desk-workflow-start",
        dataMessage("m-2", decision, { taskId: paused.id }),
      ),
      taskId: paused.id,
      savedAt: new Date(0),
    });

    const resent = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [data(decision)], { taskId: paused.id }),
    });

    expect(taskOf(resent)).toMatchObject({
      id: paused.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(seen.confirmed).toEqual(["7"]);
  });
});
