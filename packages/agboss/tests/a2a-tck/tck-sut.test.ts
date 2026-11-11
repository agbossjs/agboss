/**
 * #811: the conformance agent the official A2A TCK runs against (scripts/a2a-tck.mjs), checked
 * offline — its adapter reads each TCK scenario from the messageId only, and each scenario's path
 * answers as the TCK's own scenario files say (a text, a data artifact, a pause its follow-up
 * answers, a coded failure), through the real listener, with the official SDK client.
 */
import { TaskState, type Task } from "@a2a-js/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { sdkClientOf, textMessage } from "../a2a/server/sdk-client.js";
import { scenarioOfMessageId, serveTckSut, type TckSut } from "./tck-serve.js";

const served: TckSut[] = [];
afterEach(async () => {
  await Promise.all(served.splice(0).map((sut) => sut.close()));
});

const send = (messageId: string, taskId = "") => ({
  tenant: "",
  message: textMessage(messageId, "TCK message", { taskId }),
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: false,
  },
  metadata: undefined,
});

const taskOf = (answer: unknown): Task => {
  if (typeof answer !== "object" || answer === null || !("id" in answer))
    throw new Error("no task");
  return answer as Task;
};

describe("#811: the TCK's scenario from its messageId", () => {
  it("tck-<scenario>-<session>[-<n>], the long task's prefix; anything else none", () => {
    expect(scenarioOfMessageId("tck-complete-task-0123abcd")).toBe("complete-task");
    expect(scenarioOfMessageId("tck-stream-artifact-chunked-0123abcd-7")).toBe(
      "stream-artifact-chunked",
    );
    expect(scenarioOfMessageId("test-resubscribe-message-id")).toBe("resubscribe");
    expect(scenarioOfMessageId("tck-complete-task")).toBeUndefined();
    expect(scenarioOfMessageId("tck-complete-task-0123abcG")).toBeUndefined();
    expect(scenarioOfMessageId("m-1")).toBeUndefined();
  });
});

describe("#811: the conformance agent answers each scenario", () => {
  it("a text, a data artifact, a pause its follow-up completes, a coded failure", async () => {
    const sut = await serveTckSut(0);
    served.push(sut);
    const client = await sdkClientOf(sut.url, undefined);

    const text = taskOf(await client.sendMessage(send("tck-artifact-text-0123abcd-1")));
    const data = taskOf(await client.sendMessage(send("tck-artifact-data-0123abcd-2")));
    const paused = taskOf(await client.sendMessage(send("tck-input-required-0123abcd-3")));
    const answered = taskOf(
      await client.sendMessage(send("tck-complete-task-0123abcd-4", paused.id)),
    );
    const rejected = taskOf(await client.sendMessage(send("tck-reject-task-0123abcd-5")));

    expect(text.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Generated text content",
    });
    expect(data.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "data",
      value: { key: "value", count: 42 },
    });
    expect(paused.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(answered).toMatchObject({
      id: paused.id,
      status: { state: TaskState.TASK_STATE_COMPLETED },
    });
    expect(rejected.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  });

  it("#859 AC1: DM-ART-001's file variants — a raw file part, a url file part, output.txt text/plain", async () => {
    const sut = await serveTckSut(0);
    served.push(sut);
    const client = await sdkClientOf(sut.url, undefined);

    const raw = taskOf(await client.sendMessage(send("tck-artifact-file-0123abcd-1")));
    const url = taskOf(await client.sendMessage(send("tck-artifact-file-url-0123abcd-2")));

    expect(raw.artifacts[0]?.parts[0]).toMatchObject({
      content: { $case: "raw", value: Buffer.from("Generated file content") },
      filename: "output.txt",
      mediaType: "text/plain",
    });
    expect(url.artifacts[0]?.parts[0]).toMatchObject({
      content: { $case: "url", value: "https://example.com/output.txt" },
      filename: "output.txt",
      mediaType: "text/plain",
    });
  });

  it("a scenario header a caller sends itself is dropped: the messageId alone names it", async () => {
    const sut = await serveTckSut(0);
    served.push(sut);
    const client = await sdkClientOf(sut.url, undefined, {
      "x-agboss-tck-scenario": "artifact-data",
    });

    const task = taskOf(await client.sendMessage(send("m-1")));

    // a messageId of no scenario: the default answer, never the scenario the header claimed
    expect(task.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Hello from TCK",
    });
  });
});
