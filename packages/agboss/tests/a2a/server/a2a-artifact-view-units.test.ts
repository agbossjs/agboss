/** #1048: the client's view of a task's output artifact — which step it shows, when it starts over. */
import { describe, expect, it } from "vitest";
import { ArtifactView } from "../../../src/a2a/server/a2a-artifact-view.js";
import { A2ATaskState } from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { StreamStep } from "../../../src/run/types.js";
import { savedTask, WORKING } from "./support/unit-parts.js";

const STEP: StreamStep = { agent: "desk-agent", visit: 1, branch: "execution-1", attempt: 1 };

async function taskOf(state: A2ATaskState = A2ATaskState.Working) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  return savedTask(tasks, { skill: "unit-workflow-start" }, { ...WORKING, state });
}

/** The chunk's flags and text. */
function shapeOf(response: ReturnType<ArtifactView["textOf"]>) {
  if (response?.payload?.$case !== "artifactUpdate") return undefined;
  const { append, lastChunk, artifact } = response.payload.value;
  return { append, lastChunk, text: artifact?.parts.map((part) => JSON.stringify(part)).join("") };
}

const delta = (text: string, step: StreamStep = STEP) =>
  ({ kind: "textDelta", delta: text, step }) as const;

describe("ArtifactView.textOf", () => {
  it("the first delta starts the artifact, the next of the same step appends", async () => {
    const view = new ArtifactView();
    const task = await taskOf();

    expect(shapeOf(view.textOf(task, delta("a")))).toMatchObject({
      append: false,
      lastChunk: false,
    });
    expect(shapeOf(view.textOf(task, delta("b")))).toMatchObject({
      append: true,
      lastChunk: false,
    });
  });

  it.each([
    ["the agent", { agent: "other-agent" }],
    ["the visit", { visit: 2 }],
    ["the branch", { branch: "execution-2" }],
    ["the attempt", { attempt: 2 }],
  ] as const)("a delta of another %s starts the view anew", async (_name, change) => {
    const view = new ArtifactView();
    const task = await taskOf();
    view.textOf(task, delta("a"));

    const chunk = view.textOf(task, delta("b", { ...STEP, ...change }));

    expect(shapeOf(chunk)).toMatchObject({ append: false });
  });

  it("an event that is no text is no chunk", async () => {
    const view = new ArtifactView();
    const task = await taskOf();

    expect(view.textOf(task, { kind: "toolCall", tool: "t" })).toBeUndefined();
    expect(view.textOf(task, { kind: "discarded", step: STEP, reason: "failed" })).toBeUndefined();
  });

  it("restart() makes the next delta start the artifact over", async () => {
    const view = new ArtifactView();
    const task = await taskOf();
    view.textOf(task, delta("a"));

    view.restart();

    expect(shapeOf(view.textOf(task, delta("b")))).toMatchObject({ append: false });
  });
});

describe("ArtifactView.retractionOf", () => {
  it("replaces the step shown with nothing, once", async () => {
    const view = new ArtifactView();
    const task = await taskOf();
    view.textOf(task, delta("a"));
    const event = { kind: "discarded", step: STEP, reason: "judge-rejected" } as const;

    expect(shapeOf(view.retractionOf(task, event))).toMatchObject({
      append: false,
      lastChunk: false,
    });
    expect(view.retractionOf(task, event)).toBeUndefined();
  });

  it.each([
    ["the agent", { agent: "other-agent" }],
    ["the visit", { visit: 2 }],
    ["the branch", { branch: "execution-2" }],
    ["the attempt", { attempt: 2 }],
  ] as const)("a retraction of another %s leaves the view as it is", async (_name, change) => {
    const view = new ArtifactView();
    const task = await taskOf();
    view.textOf(task, delta("a"));

    const chunk = view.retractionOf(task, {
      kind: "discarded",
      step: { ...STEP, ...change },
      reason: "failed",
    });

    expect(chunk).toBeUndefined();
    expect(shapeOf(view.textOf(task, delta("b")))).toMatchObject({ append: true });
  });

  it("nothing shown, nothing to retract; an event that is no retraction is none", async () => {
    const view = new ArtifactView();
    const task = await taskOf();

    expect(view.retractionOf(task, { kind: "discarded", step: STEP, reason: "failed" })).toBe(
      undefined,
    );
    view.textOf(task, delta("a"));
    expect(view.retractionOf(task, delta("b"))).toBeUndefined();
  });
});

describe("ArtifactView.closing", () => {
  it.each([A2ATaskState.Failed, A2ATaskState.Canceled, A2ATaskState.Rejected])(
    "a task that ends %s after text replaces it with an empty last chunk, once",
    async (state) => {
      const view = new ArtifactView();
      const task = await taskOf(state);
      view.textOf(task, delta("a"));

      const closing = view.closing(task);

      expect(closing.map((chunk) => shapeOf(chunk))).toEqual([
        { append: false, lastChunk: true, text: expect.any(String) as string },
      ]);
      expect(view.closing(task)).toEqual([]);
    },
  );

  it("a task that completes, or whose stream showed no text, closes nothing", async () => {
    const view = new ArtifactView();

    expect(view.closing(await taskOf(A2ATaskState.Failed))).toEqual([]);
    view.textOf(await taskOf(), delta("a"));
    expect(view.closing(await taskOf(A2ATaskState.Completed))).toEqual([]);
    expect(view.closing(await taskOf(A2ATaskState.Working))).toEqual([]);
  });

  it("after a close the next delta starts the view anew", async () => {
    const view = new ArtifactView();
    const task = await taskOf(A2ATaskState.Failed);
    view.textOf(task, delta("a"));
    view.closing(task);

    expect(shapeOf(view.textOf(task, delta("b")))).toMatchObject({ append: false });
  });
});
