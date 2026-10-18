import { beforeEach, describe, expect } from "vitest";
import { WorkflowCancelledError } from "../../src/core/errors.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import type { ExecutionOutput } from "../../src/index.js";
import { callTool, failWith, ModelFailure, replyWith, testWith } from "../../src/testing/index.js";
import {
  Apply,
  Ask,
  Clerk,
  events,
  Lookup,
  resetEvents,
  workflowEvents,
  AnswerDto,
  ApplicationsApplication,
} from "./fixtures/run-events.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true, by: "dana" };
const test = testWith(ApplicationsApplication);

beforeEach(resetEvents);

const hooks = (seen = workflowEvents()): string[] => seen.map((event) => event.hook);

/** Every event carries the run's id and its thread. */
function expectOneRun(run: Pick<ExecutionOutput, "runId" | "threadId">): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect({ hook: event.hook, runId: event.runId, threadId: event.threadId }).toEqual({
      hook: event.hook,
      runId: run.runId,
      threadId: run.threadId,
    });
  }
}

describe("#244 AC1: workflow events across a pause and its resume", () => {
  test("execute → pause → resume → finish: start, pause, resume, end — one runId, the real thread", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );

    const paused = await execute(app, Ask, { text: "apply" });
    const done = await app.resume(paused.threadId, approve);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done.status).not.toBe(ExecutionStatus.Paused);
    expect(hooks()).toEqual([
      "execution-start",
      "execution-pause",
      "execution-resume",
      "execution-end",
    ]);
    const [, pause, resume, end] = workflowEvents();
    expect(pause?.detail).toMatchObject({ kind: "approval", tool: "apply", agent: "clerk-agent" });
    expect(resume?.detail).toEqual(approve);
    expect(end?.detail).toEqual(done.finish);
    expect(done.runId).toBe(paused.runId);
    expectOneRun(done);
  });

  test("onWorkflowStart stays once per run: two pauses, two resumes, one start, one end", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      callTool(Apply, { text: "job 2" }),
      replyWith(AnswerDto, { text: "Applied twice." }),
    );

    const first = await execute(app, Ask, { text: "apply twice" });
    const second = await app.resume(first.threadId, approve);
    const done = await app.resume(first.threadId, approve);

    expect([first.status, second.status]).toEqual(["paused", "paused"]);
    expect(hooks()).toEqual([
      "execution-start",
      "execution-pause",
      "execution-resume",
      "execution-pause",
      "execution-resume",
      "execution-end",
    ]);
    expectOneRun(done);
  });

  test("a run that does not pause: start, end", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(AnswerDto, { text: "2 jobs." }),
    );

    const done = await execute(app, Ask, { text: "look" });

    expect(hooks()).toEqual(["execution-start", "execution-end"]);
    expectOneRun(done);
  });
});

describe("#244 AC2: a run that fails after a resume, or is cancelled while paused, emits onError", () => {
  test("the resumed run fails: start, pause, resume, error — the error the resume rejects with", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      failWith(ModelFailure.ServerError),
    );

    const paused = await execute(app, Ask, { text: "apply" });
    const resumed = app.resume(paused.threadId, approve);

    await expect(resumed).rejects.toBeInstanceOf(AgentFailedError);
    expect(hooks()).toEqual([
      "execution-start",
      "execution-pause",
      "execution-resume",
      "execution-error",
    ]);
    expect(workflowEvents().at(-1)?.detail).toBe(await resumed.catch((error: unknown) => error));
    expectOneRun(paused);
  });

  test("a paused run is cancelled: start, pause, error (WorkflowCancelledError)", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "never" }),
    );

    const paused = await execute(app, Ask, { text: "apply" });
    const cancelled = await app.cancel(paused.threadId);

    expect(cancelled).toEqual({ cancelled: true });
    expect(hooks()).toEqual(["execution-start", "execution-pause", "execution-error"]);
    expect(workflowEvents().at(-1)?.detail).toBeInstanceOf(WorkflowCancelledError);
    expectOneRun(paused);
    // nothing is left to cancel: no second error
    expect(await app.cancel(paused.threadId)).toEqual({ cancelled: false });
    expect(hooks()).toEqual(["execution-start", "execution-pause", "execution-error"]);
  });
});

describe("#244 AC3: node-level events carry the real threadId, not the run id", () => {
  test("agent, model, tool, channel and action events before and after a resume name the thread", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );

    const paused = await execute(app, Ask, { text: "apply" });
    const done = await app.resume(paused.threadId, approve);

    const nodeEvents = events.filter((event) => !workflowEvents().includes(event));
    expect(new Set(nodeEvents.map((event) => event.hook))).toEqual(
      new Set([
        "agent-start",
        "model-start",
        "tool-start",
        "channel-start",
        "channel-end",
        "action-start",
      ]),
    );
    expect(done.threadId).not.toBe(done.runId);
    expect(new Set(nodeEvents.map((event) => event.threadId))).toEqual(new Set([done.threadId]));
    expectOneRun(done);
  });

  test("a second run on the same thread: its events carry that thread and their own run id", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      replyWith(AnswerDto, { text: "One." }),
      replyWith(AnswerDto, { text: "Two." }),
    );

    const first = await execute(app, Ask, { text: "one" });
    resetEvents();
    const second = await execute(app, Ask, { text: "two" }, { threadId: first.threadId });

    expect(second.threadId).toBe(first.threadId);
    expect(second.runId).not.toBe(first.runId);
    expectOneRun(second);
  });
});
