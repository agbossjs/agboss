import { beforeEach, describe, expect, it } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";
import {
  Apply,
  Lookup,
  resetSeen,
  SearchStart,
  Searcher,
  seen,
  ShortlistDto,
  JobSearchApplication,
} from "./fixtures/run-input.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true, by: "dana" };
const test = testWith(JobSearchApplication);

beforeEach(resetSeen);

/** The run ids every observer event and tool saw, without duplicates. */
const idsSeen = (): string[] => [
  ...new Set([...seen.events.map((event) => event.slice(event.indexOf(":") + 1)), ...seen.tools]),
];

describe("#238: one run id per run", () => {
  test("AC1: observer events (the action's too), a tool's executionContext.executionId, the Tern and the result carry the same id", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Searcher).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(ShortlistDto, { text: "2 jobs." }),
    );

    const done = await execute(app, SearchStart, { text: "rust jobs", limit: 5 });

    expect(seen.events.map((event) => event.split(":")[0])).toEqual([
      "workflow-start",
      "model-start",
      "tool-start",
      "model-start",
      "action-start",
      "workflow-end",
    ]);
    expect(seen.tools).toHaveLength(1);
    expect(seen.actions).toHaveLength(1);
    expect(idsSeen()).toEqual([done.runId]);
  });

  test("AC1: across a pause and its resume — the same id before and after", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Searcher).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(ShortlistDto, { text: "Applied." }),
    );

    const paused = await execute(app, SearchStart, { text: "apply", limit: 1 });
    const beforeResume = seen.events.length;
    const done = await app.resume(paused.thread, approve);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done.runId).toBe(paused.runId);
    expect(seen.events.length).toBeGreaterThan(beforeResume);
    expect(seen.tools).toHaveLength(1);
    expect(seen.actions).toHaveLength(1);
    expect(idsSeen()).toEqual([paused.runId]);
  });

  test("two runs get two ids", async ({ app, mockLlm }) => {
    mockLlm(Searcher).thenReturn(
      replyWith(ShortlistDto, { text: "One." }),
      replyWith(ShortlistDto, { text: "Two." }),
    );

    const first = await execute(app, SearchStart, { text: "one", limit: 1 });
    const second = await execute(
      app,
      SearchStart,
      { text: "two", limit: 1 },
      { thread: first.thread },
    );

    expect(first.runId).not.toBe(second.runId);
  });
});

describe("#238: the Tern names the run that wrote it", () => {
  it("the Tern of a run carries the run's id, the one its result has", async () => {
    const deps = await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["42"] });

    const result = await runText("Answer", deps, { runId: "run-given" });

    expect(result.runId).toBe("run-given");
    const [tern] = await deps.terns.lastTerns(result.threadId, 1);
    expect(tern).toMatchObject({ id: result.ternId, runId: "run-given", status: "answered" });
  });
});
