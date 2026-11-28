/**
 * #1356 (mutation shard `a2a-tasks`): where a tree is from its record when the record says what no
 * ordinary run leaves — a stop, an answer with no result to read, a record of a state with no
 * rule of its own — and from a checkpoint at a finish while its record has not answered.
 */
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  DurableExecutionStatus,
  executionControlOf,
  type ExecutionControl,
} from "../../src/app/execution-control.js";
import { withReservedExecutionId } from "../../src/app/tree-control.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  RecoveryApplication,
  resetRecovery,
  StampedExecutionRecordRepository,
  ReceiptDto,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication);
const THREAD = "t-1";
const TASK = "task-1";
const tree = { tenantId: "default", rootExecutionId: TASK, threadId: THREAD };

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

function controlOf(app: TestApp): ExecutionControl {
  const control = executionControlOf(app);
  if (control === undefined) throw new Error("the app has no execution control");
  return control;
}

/** The root's record as the store answers it: `status`, and whatever else the case sets. */
function recordedAs(status: string, extra: Record<string, unknown> = {}): void {
  const record = {
    id: "r-1",
    runId: TASK,
    threadId: THREAD,
    tenantId: "default",
    status,
    route: [],
    ...extra,
  };
  vi.spyOn(StampedExecutionRecordRepository.prototype, "findByTenantIdAndRunId").mockResolvedValue(
    record as never,
  );
}

describe("where a tree is, from a record the run does not leave", () => {
  test("a record a stop ended is stopped", async ({ app }) => {
    await app.ready();
    recordedAs("stopped");

    expect(await controlOf(app).executionStateOf(tree)).toEqual({
      status: DurableExecutionStatus.Stopped,
    });
  });

  test("an answered record with no finish to read is not a finish: running, its record being there", async ({
    app,
  }) => {
    await app.ready();
    recordedAs("answered", { route: [] });

    expect(await controlOf(app).executionStateOf(tree)).toEqual({
      status: DurableExecutionStatus.Running,
    });
  });

  test("a queued record, with no checkpoint, is a tree that began", async ({ app }) => {
    await app.ready();
    recordedAs("queued");

    expect(await controlOf(app).executionStateOf(tree)).toEqual({
      status: DurableExecutionStatus.Running,
    });
  });

  test("a tree whose last checkpoint is at its finish, its record not answered yet, reads finished from it", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(replyWith(ReceiptDto, { text: "Done." }));
    // the tree's end forgets its checkpoints (#1321d): here it has not got as far
    vi.spyOn(MemorySaver.prototype, "deleteThread").mockResolvedValue(undefined);
    const ended = await execute(
      app,
      OrderWorkflowStart,
      { text: "go" },
      withReservedExecutionId({ threadId: THREAD }, TASK),
    );
    vi.spyOn(
      StampedExecutionRecordRepository.prototype,
      "findByTenantIdAndRunId",
    ).mockResolvedValue(undefined);

    expect(await controlOf(app).executionStateOf(tree)).toEqual({
      status: DurableExecutionStatus.Finished,
      finish: "receipt-workflow-finish",
      output: { text: "Done." },
      spentUsd: ended.spend.totalUsd,
      spentTokens: ended.spend.totalTokens,
    });
  });
});
