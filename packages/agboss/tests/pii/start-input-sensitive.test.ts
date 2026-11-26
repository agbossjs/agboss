/**
 * #1301 (money review 2026-11-25, findings 2 and 3): a start DTO's `sensitive` fields, and a child
 * execution's input and output, are masked in every stored or emitted copy — the execution record's
 * task line (so the next turn's thread memory), the history's input and children, the child's end
 * event. A `tokenize()` field is its token, a `mask()` field its mask; the caller keeps its values.
 */
import { describe, expect, it, vi } from "vitest";
import { NodeKind } from "../../src/flow/ast.js";
import { Application } from "../../src/application/application.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { displayMask } from "../../src/dto/redact.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { writeCaseHistory } from "../../src/eval/run/case-history.js";
import {
  Observer,
  ExecutionStatus,
  Agent,
  Ttl,
  inline,
  Workflow,
  listOf,
  optional,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import type { ExecutionEndEvent } from "../../src/core/observability.js";
import { maskedStartInput } from "../../src/pii/final-output-mask.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, onStart } from "../helpers/flow.js";
import { LocalModelProvider } from "../models/providers.fixture.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import { WorkflowFinishTextDto } from "../../src/dto/index.js";
import { Window2Memory } from "../helpers/window-memory.js";
import { ContactPiiPolicy } from "./pii.fixture.js";
import {
  DeskMessageDto,
  DeskStart,
  HandOverFinish,
  ShopExecutionContext,
} from "./sensitive.fixture.js";

const AUTHOR = "zoe-7-secret";
const REPORTER = "reporter-4-secret";
const AUTHOR_2 = "kim-9-secret";
const REPORTER_2 = "reporter-8-secret";

@WorkflowStart({
  name: "child-desk-workflow-start",
  description: "A message",
  input: DeskMessageDto,
})
class ChildDeskStart {}

@WorkflowFinish({
  name: "child-desk-workflow-finish",
  description: "Handed over",
  output: DeskMessageDto,
})
class ChildDeskFinish {}

@Workflow({
  name: "child-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChildDeskStart).toFinish(ChildDeskFinish)],
})
class ChildDeskWorkflow {}

@WorkflowStart({
  name: "parent-desk-workflow-start",
  description: "A message",
  input: DeskMessageDto,
})
class ParentDeskStart {}

@WorkflowFinish({
  name: "parent-desk-workflow-finish",
  description: "Handed over",
  output: DeskMessageDto,
})
class ParentDeskFinish {}

@Workflow({
  name: "parent-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ParentDeskStart).toWorkflow(ChildDeskWorkflow).toFinish(ParentDeskFinish)],
})
class ParentDeskWorkflow {}

@Agent({
  name: "memory-desk-agent",
  description: "Answers, remembering the thread",
  prompt: inline("Answer."),
  model: "test/desk",
  input: { message: DeskMessageDto },
  memory: Window2Memory,
})
class MemoryDeskAgent {}

@WorkflowStart({
  name: "memory-desk-workflow-start",
  description: "A message",
  input: DeskMessageDto,
})
class MemoryDeskStart {}

@WorkflowFinish({
  name: "memory-desk-workflow-finish",
  description: "Answered",
  output: WorkflowFinishTextDto,
})
class MemoryDeskFinish {}

@Workflow({
  name: "memory-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(MemoryDeskStart).toAgent(MemoryDeskAgent).toFinish(MemoryDeskFinish)],
})
class MemoryDeskWorkflow {}

const ends: ExecutionEndEvent[] = [];

@Observer()
class EndObserver {
  onExecutionEnd(event: ExecutionEndEvent): void {
    ends.push(event);
  }
}

@Application({
  name: "start-input-application",
  version: "1.0.0",
  workflows: [MemoryDeskWorkflow, ParentDeskWorkflow],
  executionContext: ShopExecutionContext,
  piiPolicies: [ContactPiiPolicy],
  observers: [EndObserver],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
class StartInputApplication {}

const test = testWith(StartInputApplication, { modelProvider: LocalModelProvider });

/** No raw value of either of the two turns; the mask and the token in its place. */
const isMasked = (text: string, values: readonly string[]): void => {
  for (const value of values) expect(text).not.toContain(value);
  expect(text).toContain("<author>");
  expect(text).toMatch(/<reporter:[0-9a-f]{6,}>/u);
};

vi.mock("../../src/run/versions.js", async (original) => ({
  ...(await original<typeof import("../../src/run/versions.js")>()),
  executionVersions: () => ({
    promptVersion: "p",
    modelVersion: "m",
    configVersion: "c",
    configHash: "h",
  }),
}));

describe("#1301 finding 2: a start DTO's sensitive fields are masked in what is stored", () => {
  test("the record's task line, the history's input and the next turn's model input hold the token and the mask", async ({
    app,
    mockModel,
  }) => {
    const agent = mockModel(MemoryDeskAgent);
    agent.thenReturn(replyWith("first"), replyWith("second"));

    const first = await execute(
      app,
      MemoryDeskStart,
      { text: "hi", author: AUTHOR, reporter: REPORTER },
      { threadId: "t-start" },
    );

    expect(first.status).toBe(ExecutionStatus.Finished);
    const [turn] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, "t-start", 1);
    isMasked(turn?.task ?? "", [AUTHOR, REPORTER]);
    const [history] = await app
      .resolve(ExecutionHistoryRepository)
      .findAllByExecutionId(first.executionId);
    isMasked(JSON.stringify(history?.input), [AUTHOR, REPORTER]);

    // the second turn of the thread: its agent reads the first turn from the memory
    await execute(
      app,
      MemoryDeskStart,
      { text: "again", author: AUTHOR_2, reporter: REPORTER_2 },
      { threadId: "t-start" },
    );

    const [, second] = agent.requests;
    const seen = second === undefined ? "" : requestText(second);
    expect(seen).toContain("Earlier executions on this thread");
    expect(seen).toContain("start memory-desk-workflow-start");
    for (const value of [AUTHOR, REPORTER, AUTHOR_2, REPORTER_2]) expect(seen).not.toContain(value);
    expect(tokensIn(seen, "reporter").length).toBeGreaterThan(0);
  });

  it("a map of fields, a list and an optional DTO are masked by their declared shapes", () => {
    const graph = {
      nodes: new Map([
        [
          "s",
          {
            declaration: {
              kind: NodeKind.Start,
              options: {
                input: {
                  one: DeskMessageDto,
                  maybe: optional(DeskMessageDto),
                  many: listOf(DeskMessageDto),
                },
              },
            },
          },
        ],
      ]),
    } as never;

    const given = {
      one: { author: AUTHOR },
      many: [{ author: AUTHOR }, { author: REPORTER }],
      other: 1,
    };

    expect(maskedStartInput(graph, "s", given, displayMask)).toEqual({
      one: { author: "<author>" },
      many: [{ author: "<author>" }, { author: "<author>" }],
      other: 1,
    });
    expect(maskedStartInput(graph, "s", { maybe: { author: AUTHOR } }, displayMask)).toEqual({
      maybe: { author: "<author>" },
    });
    expect(maskedStartInput(graph, "unknown", { author: AUTHOR }, displayMask)).toEqual({
      author: AUTHOR,
    });
  });

  it("a case's past turn writes its start line masked", async () => {
    const append = vi.fn((turn: { task: string }) => Promise.resolve(turn));
    const deps = {
      graph: {
        nodes: new Map([
          [
            "desk-workflow-start",
            { declaration: { kind: NodeKind.Start, options: { input: DeskMessageDto } } },
          ],
        ]),
      },
      config: { name: "w" },
      turns: { createThread: vi.fn(), append },
    } as never;

    await writeCaseHistory(deps, { tenantId: "t", threadId: "h" }, [
      {
        start: DeskStart,
        input: { text: "q", author: AUTHOR, reporter: REPORTER },
        finish: HandOverFinish,
        output: { text: "a" },
      },
    ]);

    const [written] = append.mock.calls[0] ?? [];
    expect(written?.task).not.toContain(AUTHOR);
    expect(written?.task).not.toContain(REPORTER);
    expect(written?.task).toContain("<author>");
  });
});

describe("#1301 finding 3: a child's input and output are masked in what is stored", () => {
  test("history.children and the child's end event hold the token and the mask; the caller keeps the values", async ({
    app,
  }) => {
    ends.length = 0;

    const result = await execute(
      app,
      ParentDeskStart,
      { text: "hi", author: AUTHOR, reporter: REPORTER },
      { threadId: "t-child", includeRecord: true },
    );

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "hi", author: AUTHOR, reporter: REPORTER });
    const [history] = await app
      .resolve(ExecutionHistoryRepository)
      .findAllByExecutionId(result.executionId);
    const [child] = history?.children ?? [];
    expect(child).toBeDefined();
    isMasked(JSON.stringify(child?.input), [AUTHOR, REPORTER]);
    isMasked(JSON.stringify(child?.output), [AUTHOR, REPORTER]);
    isMasked(JSON.stringify(result.record?.children), [AUTHOR, REPORTER]);
    const childEnd = ends.find((event) => event.parentExecutionId !== undefined);
    isMasked(JSON.stringify(childEnd?.output), [AUTHOR, REPORTER]);
    const [turn] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, "t-child", 1);
    isMasked(turn?.task ?? "", [AUTHOR, REPORTER]);
  });
});
