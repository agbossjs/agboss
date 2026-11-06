/**
 * #808 AC2 (epic #805 AC1): the official SDK's client (`ClientFactory`, its JSON-RPC transport)
 * discovers an AGBoss application by its card and runs every core method against it —
 * `SendMessage` blocking and `returnImmediately`, `GetTask`, `ListTasks`, `CancelTask`,
 * `SendStreamingMessage` and `SubscribeToTask`.
 */
import { TaskState, type StreamResponse } from "@a2a-js/sdk";
import { beforeEach, describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { until } from "../../helpers/until.js";
import {
  Clerk,
  Hold,
  levers,
  ReceiptDto,
  resetRecovery,
  seen,
  Step,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { eventually } from "./rpc.js";
import { sdkClientOf, textMessage } from "./sdk-client.js";

const test = testWith(OrdersApplication);
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };
const done = replyWith(ReceiptDto, { text: "Done." });

beforeEach(resetRecovery);

const request = (messageId: string, returnImmediately = false) => ({
  tenant: "",
  message: textMessage(messageId, "go"),
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately,
  },
  metadata: undefined,
});

const taskOf = (result: unknown) => {
  if (typeof result !== "object" || result === null || !("id" in result))
    throw new Error("no task");
  return result as { id: string; contextId: string; status?: { state: TaskState } };
};

const kindsOf = (events: readonly StreamResponse[]) =>
  events.map((event) =>
    event.payload?.$case === "statusUpdate"
      ? `status:${String(TaskState[event.payload.value.status?.state ?? 0])}`
      : (event.payload?.$case ?? "none"),
  );

describe("#808 AC2: the SDK client runs every core method", () => {
  test("SendMessage (blocking) → COMPLETED with the finish's output as its artifact", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }), done);
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);

    const task = await client.sendMessage(request("m-1"));

    expect(task).toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: [
        {
          name: "receipt-workflow-finish",
          parts: [
            { content: { $case: "data", value: { text: "Done." } }, mediaType: "application/json" },
          ],
        },
      ],
    });
  });

  test("returnImmediately → the task at once; GetTask reads it later; ListTasks lists it", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);

    const sent = taskOf(await client.sendMessage(request("m-1", true)));
    await until(() => seen.holds.length === 1, "the hold started");
    const working = await client.getTask({ tenant: "", id: sent.id, historyLength: undefined });
    levers.letGo?.();
    await eventually(async () => {
      const task = await client.getTask({ tenant: "", id: sent.id, historyLength: undefined });
      return task.status?.state === TaskState.TASK_STATE_COMPLETED;
    }, "the task completed");
    const listed = await client.listTasks({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: "",
      statusTimestampAfter: undefined,
    });

    expect([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]).toContain(
      sent.status?.state,
    );
    expect(working.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(listed.tasks.map((task) => task.id)).toEqual([sent.id]);
    expect(listed.nextPageToken).toBe("");
  });

  test("CancelTask cancels the running task", async ({ a2aServer, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }));
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);
    const sent = taskOf(await client.sendMessage(request("m-1", true)));
    await until(() => seen.holds.length === 1, "the hold started");

    const canceled = await client.cancelTask({ tenant: "", id: sent.id, metadata: undefined });

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(seen.holds[0]?.aborted).toBe(true);
    await expect(
      client.cancelTask({ tenant: "", id: sent.id, metadata: undefined }),
    ).rejects.toThrow();
  });

  test("SendStreamingMessage: the task first, its changes, the output artifact, the last status", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }), done);
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);

    const events: StreamResponse[] = [];
    for await (const event of client.sendMessageStream(request("m-1"))) events.push(event);

    const kinds = kindsOf(events);
    expect(kinds[0]).toBe("task");
    expect(kinds.slice(-2)).toEqual(["artifactUpdate", "status:TASK_STATE_COMPLETED"]);
  });

  test("SubscribeToTask: the current task first, then its changes until it is over", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);
    const sent = taskOf(await client.sendMessage(request("m-1", true)));
    await until(() => seen.holds.length === 1, "the hold started");

    const events: StreamResponse[] = [];
    for await (const event of client.resubscribeTask({ tenant: "", id: sent.id })) {
      events.push(event);
      if (events.length === 1) levers.letGo?.();
    }

    const [first] = events;
    expect(first?.payload).toMatchObject({
      $case: "task",
      value: { id: sent.id, status: { state: TaskState.TASK_STATE_WORKING } },
    });
    expect(kindsOf(events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
  });
});
