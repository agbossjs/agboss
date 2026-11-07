/**
 * #833: a streamed task's view and its durable view agree. The official SDK's client streams a text
 * task of an AGBoss server; its events, applied as A2A v1.0 says — by the SDK's own `ResultManager`,
 * the task builder its server keeps — end with the artifacts `GetTask` returns: one, the output. A
 * client that joins the artifacts' text reads the answer once.
 */
import { TaskState, type Part, type StreamResponse, type Task } from "@a2a-js/sdk";
import { InMemoryTaskStore, ResultManager, ServerCallContext } from "@a2a-js/sdk/server";
import { describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import {
  AskStart,
  Desk,
  QuickLookup,
  RemoteDeskA2AExpose,
  RemoteDeskApplication,
  SingleTenantCallerResolver,
} from "../fixtures/remote.workflow.js";
import { sdkClientOf, textMessage } from "./sdk-client.js";

const test = testWith(RemoteDeskApplication);
const listener = { expose: RemoteDeskA2AExpose, callerResolver: SingleTenantCallerResolver };

const request = (messageId: string) => ({
  tenant: "",
  message: textMessage(messageId, "where is order 7?"),
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: false,
  },
  metadata: undefined,
});

/** The task the SDK's own `ResultManager` builds of `events`, in order. */
async function appliedTask(events: readonly StreamResponse[]): Promise<Task | undefined> {
  const manager = new ResultManager(new InMemoryTaskStore(), new ServerCallContext());
  for (const { payload } of events) {
    if (payload === undefined) continue;
    await manager.processEvent({ kind: payload.$case, data: payload.value } as Parameters<
      ResultManager["processEvent"]
    >[0]);
  }
  return manager.getCurrentTask();
}

const textOf = (parts: readonly Part[]): string =>
  parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");

/** Every artifact's text, joined — how many clients read a text answer. */
const joinedText = (task: Task | undefined): string =>
  (task?.artifacts ?? []).map((artifact) => textOf(artifact.parts)).join("");

/** Each artifact update's artifact id, `append` and `lastChunk`, in order. */
const chunksOf = (events: readonly StreamResponse[]) =>
  events.flatMap((event) =>
    event.payload?.$case === "artifactUpdate"
      ? [
          [
            event.payload.value.artifact?.artifactId,
            event.payload.value.append,
            event.payload.value.lastChunk,
          ],
        ]
      : [],
  );

/** The task streamed for one message by the SDK's client, the task it builds, and GetTask's. */
async function streamed(url: string) {
  const client = await sdkClientOf(url);
  const events: StreamResponse[] = [];
  for await (const event of client.sendMessageStream(request("m-1"))) events.push(event);
  const built = await appliedTask(events);
  if (built === undefined) throw new Error("the SDK built no task of the stream");
  const read = await client.getTask({ tenant: "", id: built.id, historyLength: undefined });
  return { events, built, read };
}

describe("#833: the stream's artifacts are GetTask's", () => {
  test("AC: a text answer streamed — applied as the spec says, the stream ends with GetTask's artifacts", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Desk).thenReturn(replyWith("Shipped."));
    const { url } = await a2aServer(listener);

    const { events, built, read } = await streamed(url);

    expect(chunksOf(events)).toEqual([
      [`${read.id}:output`, false, false],
      [`${read.id}:output`, false, true],
    ]);
    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(built.artifacts).toStrictEqual(read.artifacts);
    expect(read.artifacts).toHaveLength(1);
    expect(joinedText(built)).toBe("Shipped.");
  });

  test("a tool call, then the answer: one artifact, the answer once", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Desk).thenReturn(
      callTool(QuickLookup, { orderId: "7" }),
      replyWith("Order 7 shipped."),
    );
    const { url } = await a2aServer(listener);

    const { events, built, read } = await streamed(url);

    expect(chunksOf(events)).toEqual([
      [`${read.id}:output`, false, false],
      [`${read.id}:output`, false, true],
    ]);
    expect(built.artifacts).toStrictEqual(read.artifacts);
    expect(joinedText(built)).toBe("Order 7 shipped.");
  });
});

/** The text of each WORKING status update, in order. */
const workingTextsOf = (events: readonly StreamResponse[]): string[] =>
  events.flatMap((event) =>
    event.payload?.$case === "statusUpdate" &&
    event.payload.value.status?.state === TaskState.TASK_STATE_WORKING
      ? [textOf(event.payload.value.status.message?.parts ?? [])]
      : [],
  );

describe("#848: an agent's own tool call is streamed — no event injected", () => {
  test("AC: SendStreamingMessage on the real server: a `calling quick-lookup-tool` WORKING update, before the answer", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Desk).thenReturn(
      callTool(QuickLookup, { orderId: "7" }),
      replyWith("Order 7 shipped."),
    );
    const { url } = await a2aServer(listener);

    const { events, read } = await streamed(url);

    expect(workingTextsOf(events)).toContain("calling quick-lookup-tool");
    const calling = events.findIndex(
      (event) =>
        event.payload?.$case === "statusUpdate" &&
        textOf(event.payload.value.status?.message?.parts ?? []) === "calling quick-lookup-tool",
    );
    const lastChunk = events.findIndex(
      (event) => event.payload?.$case === "artifactUpdate" && event.payload.value.lastChunk,
    );
    expect(calling).toBeLessThan(lastChunk);
    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  test("AC: `app.execute(…, { onStream })`: the agent's tool call is a `toolCall` event, once, before the answer's text", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Desk).thenReturn(
      callTool(QuickLookup, { orderId: "7" }),
      replyWith("Order 7 shipped."),
    );
    const heard: ExecutionStreamEvent[] = [];

    await app.execute(
      AskStart,
      { text: "where is order 7?" },
      {
        onStream: (event) => heard.push(event),
      },
    );

    expect(heard.filter((event) => event.kind === "toolCall")).toEqual([
      { kind: "toolCall", tool: "quick-lookup-tool" },
    ]);
    const call = heard.findIndex((event) => event.kind === "toolCall");
    const answer = heard.findIndex(
      (event) => event.kind === "textDelta" && event.delta.includes("shipped"),
    );
    expect(call).toBeLessThan(answer);
  });

  test("a listener that throws on the tool call never fails the run: the tool runs, the run finishes", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Desk).thenReturn(
      callTool(QuickLookup, { orderId: "7" }),
      replyWith("Order 7 shipped."),
    );
    const heard: ExecutionStreamEvent[] = [];

    const result = await app.execute(
      AskStart,
      { text: "where is order 7?" },
      {
        onStream: (event) => {
          heard.push(event);
          if (event.kind === "toolCall") throw new Error("the stream's socket closed");
        },
      },
    );

    expect(result.output).toEqual({ text: "Order 7 shipped." });
    expect(result.toolCalls.map((call) => call.status)).toEqual(["succeeded"]);
    expect(heard.some((event) => event.kind === "toolCall")).toBe(true);
  });
});
