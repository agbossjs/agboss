/**
 * #808 (security review): the caller resolver is asked about the very request the handler acts on.
 * The operation and the task are decoded once, by the SDK's own proto-JSON decoder — so an alias
 * (`task_id`), a number for a text or a key given twice names, for the resolver, the task the
 * handler would resume — and a key that may not answer pauses is refused (`403`) whatever the
 * spelling; the task it names is never touched.
 */
import { beforeEach, describe, expect } from "vitest";
import { callTool, testWith } from "../../../src/testing/index.js";
import {
  Charge,
  Clerk,
  resetRecovery,
  seen,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { asked, BearerCallerResolver, resetAsked } from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { post, rpc, rpcBody, text, userMessage } from "./rpc.js";

const test = testWith(OrdersApplication);
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };
const READ_ONLY = { owner: "dana:read-only" };

beforeEach(() => {
  resetRecovery();
  resetAsked();
});

/** Dana's task, paused at its charge's approval: its id. */
async function pausedTask(url: string): Promise<string> {
  const sent = await rpc(url, "SendMessage", { message: userMessage("m-1", [text("go")]) });
  const { task } = sent.body.result as { task: { id: string; status: { state: string } } };
  if (task.status.state !== "TASK_STATE_INPUT_REQUIRED") throw new Error(task.status.state);
  return task.id;
}

const approval = { data: { decision: { approved: true } }, mediaType: "application/json" };

/** The task's state, as dana reads it. */
const stateOf = async (url: string, id: string): Promise<string> =>
  ((await rpc(url, "GetTask", { id })).body.result as { status: { state: string } }).status.state;

describe("#808: the resolver sees the request the handler acts on", () => {
  test("a follow-up naming its task as task_id is a resume for the resolver: 403, nothing resumed", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const { url } = await a2aServer(listener);
    const taskId = await pausedTask(url);
    resetAsked();

    const answer = await rpc(
      url,
      "SendMessage",
      { message: { messageId: "m-2", role: "ROLE_USER", parts: [approval], task_id: taskId } },
      READ_ONLY,
    );

    expect(answer.status).toBe(403);
    expect(asked.map((request) => request.taskId)).toEqual([taskId]);
    expect(await stateOf(url, taskId)).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(seen.charges).toEqual([]);
  });

  test("a taskId given twice is the one the handler reads (the last): 403, nothing resumed", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const { url } = await a2aServer(listener);
    const taskId = await pausedTask(url);
    resetAsked();
    const message = `{"messageId":"m-2","role":"ROLE_USER","parts":[${JSON.stringify(approval)}],"taskId":"","taskId":${JSON.stringify(taskId)}}`;
    const body = `{"jsonrpc":"2.0","id":7,"method":"SendMessage","params":{"message":${message}}}`;

    const answer = await post(url, body, READ_ONLY);

    expect(answer.status).toBe(403);
    expect(asked.map((request) => request.taskId)).toEqual([taskId]);
    expect(seen.charges).toEqual([]);
  });

  test("a taskId that is a number is the text the handler reads: 403", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(
      url,
      "SendMessage",
      { message: { messageId: "m-2", role: "ROLE_USER", parts: [approval], taskId: 42 } },
      READ_ONLY,
    );

    expect(answer.status).toBe(403);
    expect(asked.map((request) => request.taskId)).toEqual(["42"]);
  });

  test("GetTask, CancelTask and SubscribeToTask name their id to the resolver as the handler decodes it", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    await rpc(url, "GetTask", { id: 7 });
    await rpc(url, "CancelTask", { id: "task-b", metadata: {} });
    await post(url, rpcBody("SubscribeToTask", { id: "task-c" }));

    expect(asked.map(({ operation, taskId }) => `${operation}:${String(taskId)}`)).toEqual([
      "GetTask:7",
      "CancelTask:task-b",
      "SubscribeToTask:task-c",
    ]);
  });
});
