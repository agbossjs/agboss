import { describe, expect } from "vitest";
import type { Class } from "../../src/components/injection.js";
import { replyWith, testWith, type ModelScript } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { usd } from "../../src/units/index.js";
import {
  Answer,
  Noter,
  RecallDto,
  Recaller,
  TaskStart,
  WindowDto,
  Windowed,
  CompactingDeskApplication,
  DeskMemory,
  MemoryDeskApplication,
} from "./fixtures/memory.workflow.js";
import { execute } from "../helpers/flow.js";

/** What the model read in its last request: the thread's memory and the input message. */
const inputOf = (script: ModelScript): string => {
  const request = script.lastRequest;
  if (request.kind !== "chat") return "";
  return request.messages
    .filter((line) => line.role === "human")
    .map((line) => (typeof line.text === "string" ? line.text : JSON.stringify(line.text)))
    .join("\n\n");
};

/** The earlier turns (their start lines, #272 S8) the model saw in its last request. */
const turnsSeen = (script: ModelScript): string[] =>
  [...inputOf(script).matchAll(/^start task-workflow-start: \{"text":"(.+)"\}$/gmu)].map(
    (match) => match[1] ?? "",
  );

/** Every agent of the memory desk answers "ok". */
const answerOk = (mockModel: (agent: Class) => ModelScript): void => {
  mockModel(Recaller).thenReturnAlways(replyWith(RecallDto, { text: "ok" }));
  mockModel(Windowed).thenReturnAlways(replyWith(WindowDto, { text: "ok" }));
  mockModel(Noter).thenReturnAlways(replyWith("ok"));
};

/** `count` turns on one thread: t1, t2, …; returns the last result. */
async function converse(app: TestApp, count: number) {
  let result = await execute(app, TaskStart, { text: "t1" });
  for (let turn = 2; turn <= count; turn++) {
    result = await execute(
      app,
      TaskStart,
      { text: `t${String(turn)}` },
      { threadId: result.threadId },
    );
  }
  return result;
}

describe("memory on agent model calls (#1303)", () => {
  const test = testWith(MemoryDeskApplication);

  test("AC1: with a window of N, the model request holds at most N earlier turns", async ({
    app,
    mockModel,
  }) => {
    answerOk(mockModel);

    await converse(app, 6);

    expect(turnsSeen(mockModel(Windowed))).toEqual(["t4", "t5"]);
  });

  test("an agent's own memory is used for that agent only; NoMemory sees no earlier turn", async ({
    app,
    mockModel,
  }) => {
    answerOk(mockModel);

    await converse(app, 6);

    expect(turnsSeen(mockModel(Noter))).toEqual([]);
    expect(turnsSeen(mockModel(Recaller))).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

describe("a memory's compaction", () => {
  const test = testWith(CompactingDeskApplication);

  test("AC2: compaction cost is recorded in the run's cost report", async ({ app, mockModel }) => {
    mockModel(Recaller).thenReturnAlways(
      replyWith(RecallDto, { text: "ok" }, { cost: usd(0.001) }),
    );
    mockModel(DeskMemory).thenReturn(replyWith("t1 and t2 were asked", { cost: usd(0.004) }));

    // window 1, 2 turns between compactions: before turn 4 reads the thread, t1 and t2 are older
    const fourth = await converse(app, 4);

    expect(fourth.compacted).toMatchObject([
      { memory: "desk-memory", fromTurn: 1, toTurn: 2, summaries: 1 },
    ]);
    expect(fourth.spend.byCategory.memory).toBeCloseTo(0.004, 6);
    expect(fourth.spend.totalUsd).toBeCloseTo(0.005, 6);
    expect(fourth.spend.trace.map((line) => line.caller)).toEqual([
      "memory:desk-memory",
      "recaller-agent",
    ]);
  });

  test("agents then see the summary and the turns not yet compacted", async ({
    app,
    mockModel,
  }) => {
    mockModel(Recaller).thenReturnAlways(replyWith(RecallDto, { text: "ok" }));
    mockModel(DeskMemory).thenReturn(replyWith("t1 and t2 were asked"));

    await converse(app, 4);

    expect(inputOf(mockModel(Recaller))).toContain(
      "Earlier in this conversation:\n[1] t1 and t2 were asked",
    );
    expect(turnsSeen(mockModel(Recaller))).toEqual(["t3"]);
  });
});
