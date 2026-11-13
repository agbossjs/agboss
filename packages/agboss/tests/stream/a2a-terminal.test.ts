/**
 * #1006 AC4: the client's view of an A2A task's output artifact never keeps rejected text — a
 * retry starts it anew, a retraction empties it, and a task that ends FAILED, CANCELED or REJECTED
 * replaces what it showed with an empty last chunk before its final status.
 */
import { TaskState, type StreamResponse } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2ATaskState, type A2ATaskRecord } from "../../src/infrastructure/a2a-task.repository.js";
import { ArtifactView } from "../../src/a2a/server/a2a-artifact-view.js";
import type { ExecutionStreamEvent, StreamStep } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  AskStart,
  Desk,
  RemoteDeskApplication,
  RemoteDeskA2AExpose,
  SingleTenantCallerResolver,
  SlowLookup,
  slowLookups,
} from "../a2a/fixtures/remote.workflow.js";
import { sdkClientOf, textMessage } from "../a2a/server/sdk-client.js";
import { until } from "../helpers/until.js";
import { A2AJudge, A2AJudgedApplication, A2AWriter, judgedListener } from "./a2a-judged.fixture.js";
import { chunksOf, statesOf, streamed, viewOf } from "./a2a-view.js";
import { useCanary } from "./canary.js";

const judged = testWith(A2AJudgedApplication);
const remote = testWith(RemoteDeskApplication);

describe("#1006 AC4: a judge retry on the A2A stream", () => {
  judged(
    "the retry's first chunk replaces the draft; the output closes the artifact",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(A2AWriter).thenReturn(replyWith("BAD DRAFT"), replyWith("Good."));
      mockLlm(A2AJudge).thenReturn(replyWith("FAIL judge says"), replyWith("PASS judge says"));
      const { url } = await a2aServer(judgedListener);

      const events = await streamed(url, "m-retry");
      const chunks = chunksOf(events);

      expect(chunks).toEqual([
        { text: "BAD DRAFT", append: false, last: false },
        { text: "", append: false, last: false }, // the draft is retracted at once
        { text: "Good.", append: false, last: false }, // the retry starts the view anew
        { text: "Good.", append: false, last: true }, // the output
      ]);
      expect(viewOf(chunks)).toBe("Good.");
      expect(statesOf(events).at(-1)).toBe(String(TaskState.TASK_STATE_COMPLETED));
    },
  );

  judged(
    "a FAILED task ends with an empty last chunk before its status; GetTask agrees",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(A2AWriter).thenReturn(replyWith("ONE"), replyWith("TWO"));
      mockLlm(A2AJudge).thenReturn(replyWith("FAIL"), replyWith("FAIL"));
      const { url } = await a2aServer(judgedListener);

      const events = await streamed(url, "m-failed");
      const chunks = chunksOf(events);

      expect(chunks.at(-1)).toEqual({ text: "", append: false, last: true });
      expect(viewOf(chunks)).toBe("");
      const closing = events.findIndex(
        (event) => event.payload?.$case === "artifactUpdate" && event.payload.value.lastChunk,
      );
      const failed = events.findIndex(
        (event) =>
          event.payload?.$case === "statusUpdate" &&
          event.payload.value.status?.state === TaskState.TASK_STATE_FAILED,
      );
      expect(closing).toBeGreaterThan(-1);
      expect(closing).toBeLessThan(failed);
      const taskId = taskIdOf(events);
      const client = await sdkClientOf(url);
      const read = await client.getTask({ tenant: "", id: taskId, historyLength: undefined });
      expect(read.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(read.artifacts).toEqual([]);
    },
  );
});

function taskIdOf(events: readonly StreamResponse[]): string {
  const first = events[0]?.payload;
  if (first?.$case !== "task") throw new Error("the stream starts with the task");
  return first.value.id;
}

describe("#1006 AC4: a CANCELED task", () => {
  useCanary();
  const listener = { expose: RemoteDeskA2AExpose, callerResolver: SingleTenantCallerResolver };

  remote(
    "its stream's view is emptied before the CANCELED status",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Desk).thenReturn(callTool(SlowLookup, { orderId: "7" }));
      let started = false;
      slowLookups.started = () => {
        started = true;
      };
      const { url } = await a2aServer(listener);
      const client = await sdkClientOf(url);
      const events: StreamResponse[] = [];
      const reading = (async () => {
        const request = {
          tenant: "",
          message: textMessage("m-cancel", "where is order 7?"),
          configuration: {
            acceptedOutputModes: [],
            taskPushNotificationConfig: undefined,
            returnImmediately: false,
          },
          metadata: undefined,
        };
        for await (const event of client.sendMessageStream(request)) events.push(event);
      })();
      await until(() => started && events.length > 0, "the lookup started and the task event came");

      await client.cancelTask({ tenant: "", id: taskIdOf(events), metadata: undefined });
      await reading;

      const chunks = chunksOf(events);
      expect(chunks[0]).toEqual({ text: "CANARY", append: false, last: false });
      expect(chunks.at(-1)).toEqual({ text: "", append: false, last: true });
      expect(viewOf(chunks)).toBe("");
      expect(statesOf(events).at(-1)).toBe(String(TaskState.TASK_STATE_CANCELED));
      slowLookups.started = () => undefined;
    },
  );
});

const STEP: StreamStep = { agent: "a", visit: 1, branch: "e", attempt: 1 };
const taskIn = (state: A2ATaskState): A2ATaskRecord => ({
  tenantId: "acme",
  taskId: "t",
  ownerId: "dana",
  contextId: "c",
  skill: "s",
  status: { state, pendingPauses: [] },
  version: 1,
  acceptedAt: new Date(0),
  statusAt: new Date(0),
});
const text: ExecutionStreamEvent = { kind: "textDelta", delta: "x", step: STEP };

describe("#1006 AC4: the view of a task that ends without an output", () => {
  for (const state of [A2ATaskState.Failed, A2ATaskState.Canceled, A2ATaskState.Rejected]) {
    it(`${state} after streamed text: one empty last chunk, once`, () => {
      const view = new ArtifactView();
      view.textOf(taskIn(A2ATaskState.Working), text);

      const closing = view.closing(taskIn(state));

      expect(chunksOf(closing)).toEqual([{ text: "", append: false, last: true }]);
      expect(view.closing(taskIn(state))).toEqual([]);
    });
  }

  for (const state of [A2ATaskState.Completed, A2ATaskState.InputRequired, A2ATaskState.Working]) {
    it(`${state} keeps what it showed`, () => {
      const view = new ArtifactView();
      view.textOf(taskIn(A2ATaskState.Working), text);
      expect(view.closing(taskIn(state))).toEqual([]);
    });
  }

  it("a task that streamed nothing has nothing to replace", () => {
    expect(new ArtifactView().closing(taskIn(A2ATaskState.Failed))).toEqual([]);
  });

  it("a retraction of a step that is not shown changes nothing; of the one shown, empties it", () => {
    const view = new ArtifactView();
    const task = taskIn(A2ATaskState.Working);
    view.textOf(task, { ...text, step: { ...STEP, branch: "other" } });
    view.textOf(task, text);

    const other = view.retractionOf(task, {
      kind: "discarded",
      step: { ...STEP, branch: "other" },
      reason: "judge-rejected",
    });
    const shown = view.retractionOf(task, {
      kind: "discarded",
      step: STEP,
      reason: "judge-rejected",
    });

    expect(other).toBeUndefined();
    expect(chunksOf(shown === undefined ? [] : [shown])).toEqual([
      { text: "", append: false, last: false },
    ]);
  });

  it("another step starts the view anew; the same step appends", () => {
    const view = new ArtifactView();
    const task = taskIn(A2ATaskState.Working);
    const chunks = [
      view.textOf(task, text),
      view.textOf(task, text),
      view.textOf(task, { ...text, step: { ...STEP, attempt: 2 } }),
    ];
    expect(
      chunksOf(chunks.flatMap((chunk) => (chunk === undefined ? [] : [chunk]))).map(
        (c) => c.append,
      ),
    ).toEqual([false, true, false]);
  });
});
