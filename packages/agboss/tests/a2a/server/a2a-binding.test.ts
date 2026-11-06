/**
 * #808 AC2, AC5: the JSON-RPC binding — the `A2A-Version` check (none means 0.3: `-32009`), the
 * push methods `-32003`, an unknown method `-32601`, a body over `maxBodySize` `413` with nothing
 * run; the caller resolver asked after the body is read, with the operation and the task, its
 * refusal a real `401` / `403` (a resolver that throws: `500`, without its text) and nothing run.
 */
import { beforeEach, describe, expect } from "vitest";
import { A2AOperation } from "../../../src/a2a/index.js";
import { A2ATaskRepository } from "../../../src/infrastructure/a2a-task.repository.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { kilobytes } from "../../../src/units/index.js";
import {
  Clerk,
  ReceiptDto,
  resetRecovery,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  asked,
  BearerCallerResolver,
  EXPLODING_TOKEN,
  RESOLVER_SECRET,
  resetAsked,
} from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { errorInfoOf, errorOf, post, rpc, rpcBody, sseEvents, text, userMessage } from "./rpc.js";

const test = testWith(OrdersApplication);
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };
const done = replyWith(ReceiptDto, { text: "Done." });
const send = (messageId: string) => ({ message: userMessage(messageId, [text("go")]) });

beforeEach(() => {
  resetRecovery();
  resetAsked();
});

describe("#808 AC2: the version check, the push methods, unknown methods", () => {
  test("no A2A-Version means 0.3: -32009 naming the version, nothing run", async ({
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer(listener);

    const none = await rpc(url, "SendMessage", send("m-1"), { version: null });
    const legacy = await rpc(url, "SendMessage", send("m-2"), { version: "0.3" });

    expect(errorOf(none)).toMatchObject({
      code: -32009,
      message: "the A2A version is not served: this agent serves 1.0",
    });
    expect(errorInfoOf(none)?.code).toBe("a2a.version-unsupported");
    // the caller's header is never echoed back
    const odd = await rpc(url, "SendMessage", send("m-3"), { version: "9.9-<b>" });
    expect(JSON.stringify(odd.body)).not.toContain("9.9-<b>");
    expect(errorOf(legacy).code).toBe(-32009);
    expect(asked).toEqual([]);
    expect(mockLlm(Clerk)).toHaveBeenCalledTimes(0);
  });

  test("every push method is -32003; GetExtendedAgentCard is -32007", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);
    const methods = [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
    ];

    const codes = await Promise.all(
      methods.map(
        async (method) => errorOf(await rpc(url, method, { taskId: "t-1", id: "c-1" })).code,
      ),
    );

    expect(codes).toEqual([-32003, -32003, -32003, -32003]);
    expect(errorOf(await rpc(url, "GetExtendedAgentCard", {})).code).toBe(-32007);
  });

  test("an unknown method is -32601, a body that is no JSON -32700 or -32602", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const unknown = await rpc(url, "message/send", send("m-1"));
    const garbage = await post(url, "{not json");

    expect(errorOf(unknown).code).toBe(-32601);
    expect([-32700, -32602]).toContain(errorOf(garbage).code);
  });

  test("a body over maxBodySize is 413: nothing read further, asked or run", async ({
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer({ ...listener, maxBodySize: kilobytes(1) });
    const big = { message: userMessage("m-1", [text("x".repeat(2048))]) };

    const answer = await post(url, rpcBody("SendMessage", big));

    expect(answer.status).toBe(413);
    expect(answer.body).toEqual({
      code: "a2a.body-too-large",
      error: "the request body is too large",
    });
    expect(asked).toEqual([]);
    expect(mockLlm(Clerk)).toHaveBeenCalledTimes(0);
  });
});

describe("#808 AC5: the caller resolver gets the operation and the task", () => {
  test("each operation, with the task it names", async ({ a2aServer, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    const { url } = await a2aServer(listener);
    const sent = await rpc(url, "SendMessage", send("m-1"));
    const taskId = (sent.body.result as { task: { id: string } }).task.id;

    await rpc(url, "GetTask", { id: taskId });
    await rpc(url, "ListTasks", {});
    await rpc(url, "CancelTask", { id: taskId });
    await rpc(url, "SendMessage", { message: userMessage("m-2", [text("ok")], { taskId }) });
    await sseEvents(url, "SubscribeToTask", { id: taskId });
    await sseEvents(url, "SendStreamingMessage", send("m-3"), { count: 1 });

    expect(asked.map(({ operation, taskId: named }) => ({ operation, taskId: named }))).toEqual([
      { operation: A2AOperation.SendMessage, taskId: undefined },
      { operation: A2AOperation.GetTask, taskId },
      { operation: A2AOperation.ListTasks, taskId: undefined },
      { operation: A2AOperation.CancelTask, taskId },
      { operation: A2AOperation.SendMessage, taskId },
      { operation: A2AOperation.SubscribeToTask, taskId },
      { operation: A2AOperation.SendStreamingMessage, taskId: undefined },
    ]);
  });

  test("no token → 401 with the challenge: nothing run, nothing kept", async ({
    a2aServer,
    app,
    mockLlm,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", send("m-1"), { owner: null });

    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toBe('Bearer realm="a2a"');
    expect(answer.body).toEqual({ code: "a2a.caller-unauthenticated", error: "no token" });
    expect(mockLlm(Clerk)).toHaveBeenCalledTimes(0);
    const page = await app
      .resolve(A2ATaskRepository)
      .list({ tenantId: "default", ownerId: undefined, pageSize: 10 });
    expect(page.tasks).toEqual([]);
  });

  test("a streaming request is refused with a real 401, not an event stream", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await sseEvents(url, "SendStreamingMessage", send("m-1"), { owner: null });

    expect(answer.status).toBe(401);
    expect(answer.contentType).toContain("application/json");
  });

  test("a key that may not answer pauses → 403 on a follow-up, nothing resumed", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(
      url,
      "SendMessage",
      { message: userMessage("m-2", [text("ok")], { taskId: "task-1" }) },
      { owner: "dana:read-only" },
    );

    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({
      code: "a2a.caller-forbidden",
      error: "this key may not answer pauses",
    });
  });

  test("a resolver that throws → 500 without its text, nothing run", async ({
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", send("m-1"), { owner: EXPLODING_TOKEN });

    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({
      code: "a2a.caller-resolution-failed",
      error: "the caller could not be resolved",
    });
    expect(JSON.stringify(answer.body)).not.toContain(RESOLVER_SECRET);
    expect(mockLlm(Clerk)).toHaveBeenCalledTimes(0);
  });

  test("a request activating the skills extension gets it echoed", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(
      url,
      "GetTask",
      { id: "none" },
      {
        headers: { "a2a-extensions": "https://agboss.dev/a2a/skills/v1, https://other.example/x" },
      },
    );

    expect(answer.headers.get("a2a-extensions")).toBe("https://agboss.dev/a2a/skills/v1");
    expect(errorOf(answer).code).toBe(-32001);
    expect(errorInfoOf(answer)).toBeUndefined();
  });
});
