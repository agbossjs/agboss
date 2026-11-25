/**
 * #1301 (DSL-Review 13): a final output DTO's `sensitive` fields are masked in every stored final
 * output — the execution record's finish line (and so the thread's history and a late resume), the
 * history record, the end event the A2A task is written from, a direct reply, a case's past turn.
 * A `tokenize()` field is its token, a `mask()` field its mask; the caller of `execute` keeps the
 * values it was given.
 */
import { describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { endedResultOf } from "../../src/app/ended-output.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { NodeKind } from "../../src/flow/ast.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { displayMask } from "../../src/dto/redact.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { writeCaseHistory } from "../../src/eval/run/case-history.js";
import { Observer, ExecutionStatus } from "../../src/index.js";
import type { ExecutionEndEvent } from "../../src/core/observability.js";
import { maskedFinishOutput, maskedOutputOf } from "../../src/pii/final-output-mask.js";
import { routeTo, testWith } from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { LocalModelProvider } from "../models/providers.fixture.js";
import { ContactPiiPolicy } from "./pii.fixture.js";
import {
  DeskMessageDto,
  DeskRouter,
  DeskStart,
  HandOverFinish,
  SensitiveWorkflow,
  ShopExecutionContext,
} from "./sensitive.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const AUTHOR = "zoe-7-secret";
const REPORTER = "reporter-4-secret";

vi.mock("../../src/run/versions.js", async (original) => ({
  ...(await original<typeof import("../../src/run/versions.js")>()),
  executionVersions: () => ({
    promptVersion: "p",
    modelVersion: "m",
    configVersion: "c",
    configHash: "h",
  }),
}));

const ends: ExecutionEndEvent[] = [];

@Observer()
class EndObserver {
  onExecutionEnd(event: ExecutionEndEvent): void {
    ends.push(event);
  }
}

@Application({
  name: "final-output-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SensitiveWorkflow],
  executionContext: ShopExecutionContext,
  piiPolicies: [ContactPiiPolicy],
  observers: [EndObserver],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
class FinalOutputApplication {}

const test = testWith(FinalOutputApplication, { modelProvider: LocalModelProvider });

const graph = {
  nodes: new Map([
    [
      "hand-over-workflow-finish",
      { declaration: { kind: NodeKind.Finish, options: { output: DeskMessageDto } } },
    ],
  ]),
} as never;

const isMasked = (text: string): void => {
  expect(text).not.toContain(AUTHOR);
  expect(text).not.toContain(REPORTER);
  expect(text).toContain("<author>");
  expect(text).toMatch(/<reporter:[0-9a-f]{6,}>/u);
};

describe("#1301: sensitive fields of a final output are masked in what is stored", () => {
  test("record, history, end event and a late read hold the token and the mask; the caller keeps the values", async ({
    app,
    mockModel,
  }) => {
    ends.length = 0;
    mockModel(DeskRouter).thenReturn(routeTo(HandOverFinish));

    const result = await execute(
      app,
      DeskStart,
      { text: "hi", author: AUTHOR, reporter: REPORTER },
      { threadId: "t-final" },
    );

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "hi", author: AUTHOR, reporter: REPORTER });
    const [turn] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, "t-final", 1);
    isMasked(turn?.replyWith ?? "");
    const [history] = await app
      .resolve(ExecutionHistoryRepository)
      .findAllByExecutionId(result.executionId);
    isMasked(JSON.stringify(history?.output));
    expect(ends).toHaveLength(1);
    isMasked(JSON.stringify(ends[0]?.output));
    // the late resume of an ended tree reads the line back: the token stays a token
    const late = endedResultOf(graph, { ...turn, status: "answered" } as never);
    isMasked(JSON.stringify(late?.output));
    expect(late?.output).toBeInstanceOf(DeskMessageDto);
  });
});

describe("#1301: the other writers of a final output", () => {
  it("a list's items are masked by the class each one is; a name that is no finish stays as it is", () => {
    const shown = maskedOutputOf([DeskMessageDto], [{ text: "a", author: AUTHOR }], displayMask);

    expect(shown).toEqual([{ text: "a", author: "<author>" }]);
    expect(maskedFinishOutput(graph, "unknown", { author: AUTHOR }, displayMask)).toEqual({
      author: AUTHOR,
    });
  });

  it("a case's past turn is written masked (without a PII runtime a token field is its placeholder)", async () => {
    const append = vi.fn((turn: { replyWith: string }) => Promise.resolve(turn));
    const deps = {
      graph,
      config: { name: "w" },
      turns: { createThread: vi.fn(), append },
    } as never;

    await writeCaseHistory(deps, { tenantId: "t", threadId: "h" }, [
      {
        start: DeskStart,
        input: { text: "q" },
        finish: HandOverFinish,
        output: { text: "a", author: AUTHOR, reporter: REPORTER },
      },
    ]);

    const [written] = append.mock.calls[0] ?? [];
    expect(written?.replyWith).not.toContain(AUTHOR);
    expect(written?.replyWith).not.toContain(REPORTER);
    expect(written?.replyWith).toContain("<reporter>");
  });
});
