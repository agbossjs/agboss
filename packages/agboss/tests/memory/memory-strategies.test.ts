import { beforeEach, describe, expect, it } from "vitest";
import type { Class } from "../../src/components/injection.js";
import { workflowOf } from "../../src/components/assemble.js";
import { Agent, Workflow, WorkflowSettings } from "../../src/index.js";
import { replyWith, testWith, type ModelScript } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { usd } from "../../src/units/index.js";
import type { BaseMemoryStrategy } from "../../src/memory/index.js";
import {
  Answer,
  NOTED,
  Noter,
  RecallDto,
  Recaller,
  TaskStart,
  WindowDto,
  Windowed,
  CompactingDeskApplication,
  DeskCompaction,
  MemoryDeskApplication,
} from "./fixtures/memory.workflow.js";
import { execute, start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";

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
const answerOk = (mockLlm: (agent: Class) => ModelScript): void => {
  mockLlm(Recaller).thenReturnAlways(replyWith(RecallDto, { text: "ok" }));
  mockLlm(Windowed).thenReturnAlways(replyWith(WindowDto, { text: "ok" }));
  mockLlm(Noter).thenReturnAlways(replyWith("ok"));
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

describe("memory strategies on agent model calls", () => {
  const test = testWith(MemoryDeskApplication);
  beforeEach(() => {
    NOTED.length = 0;
  });

  test("AC1: with a sliding window of N, the model request holds at most N earlier turns", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);

    await converse(app, 6);

    expect(turnsSeen(mockLlm(Windowed))).toEqual(["t4", "t5"]);
  });

  test("an agent's own strategy is used for that agent only; the others keep the workflow's default", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);

    await converse(app, 6);

    expect(turnsSeen(mockLlm(Noter))).toEqual(["t5"]);
    expect(turnsSeen(mockLlm(Recaller))).toEqual(["t2", "t3", "t4", "t5"]);
  });

  test("after every finished turn the strategy updates its memory (created by the container, with its deps)", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);

    await converse(app, 3);

    expect(NOTED).toEqual(
      ["t1", "t2", "t3"].map((text) => `start task-workflow-start: {"text":"${text}"}`),
    );
  });
});

describe("compaction is the built-in strategy's memory update", () => {
  const test = testWith(CompactingDeskApplication);

  test("AC2: compaction cost is recorded in the run's cost report", async ({ app, mockLlm }) => {
    mockLlm(Recaller).thenReturnAlways(replyWith(RecallDto, { text: "ok" }, { cost: usd(0.001) }));
    mockLlm(DeskCompaction).thenReturn(replyWith("t1 and t2 were asked", { cost: usd(0.004) }));

    // window 1, 2 turns between compactions: before turn 4 reads the thread, t1 and t2 are older
    const fourth = await converse(app, 4);

    expect(fourth.compacted).toMatchObject([
      { compaction: "desk-compaction", fromTurn: 1, toTurn: 2, summaries: 1 },
    ]);
    expect(fourth.spend.byCategory.compaction).toBeCloseTo(0.004, 6);
    expect(fourth.spend.totalUsd).toBeCloseTo(0.005, 6);
    expect(fourth.spend.trace.map((line) => line.caller)).toEqual([
      "compaction:desk-compaction",
      "recaller-agent",
    ]);
  });

  test("agents then see the summary and the turns not yet compacted", async ({ app, mockLlm }) => {
    mockLlm(Recaller).thenReturnAlways(replyWith(RecallDto, { text: "ok" }));
    mockLlm(DeskCompaction).thenReturn(replyWith("t1 and t2 were asked"));

    await converse(app, 4);

    expect(inputOf(mockLlm(Recaller))).toContain(
      "Earlier in this conversation:\n[1] t1 and t2 were asked",
    );
    expect(turnsSeen(mockLlm(Recaller))).toEqual(["t3"]);
  });
});

class NotAStrategy {
  readonly kind = "not a strategy";
}
const notAStrategy: Class = NotAStrategy;

@Agent({
  name: "odd-agent",
  prompt: "Odd.",
  description: "Has a class that is no strategy",
  model: "local/llama",
  memoryStrategy: notAStrategy as Class<BaseMemoryStrategy>,
})
class Odd {}

@Workflow({
  name: "odd-desk-workflow",
  version: "1.0.0",
  flow: [start(TaskStart).returns(WorkflowStartTextDto).toAgent(Odd).toFinish(Answer)],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 1,
})
class OddDesk {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder().build();
  }
}

describe("assembly", () => {
  it("a memoryStrategy that does not extend BaseMemoryStrategy fails assembly", async () => {
    await expect(workflowOf(OddDesk)).rejects.toThrow("[memory.not-a-strategy]");
  });
});
