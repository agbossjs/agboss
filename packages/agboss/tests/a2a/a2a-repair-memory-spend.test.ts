/**
 * #844 (money): what read repair signs for a finished tree is what its end event reports — its
 * agents' memory update after the turn included, a spend the checkpoint never holds. The record
 * is written after that update, so a repair from the records signs the whole spend, never less.
 */
import { describe, expect, it } from "vitest";
import { DurableExecutionStatus, executionControlOf } from "../../src/app/execution-control.js";
import { finishedSpendOf } from "../../src/app/execution-trees.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { durableStatusOf } from "../../src/a2a/tasks/task-status.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  MEMORY_UPDATE_COST,
  MemoApplication,
  MemoAgent,
  MemoStart,
} from "./fixtures/memory-spend.application.js";

const test = testWith(MemoApplication);

describe("#844: a repaired task signs the spend its end event reports", () => {
  test("AC1: a memory update after the turn is in the finished state's spend, as in the end event's", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MemoAgent).thenReturn(replyWith("Shipped."));
    const result = await execute(app, MemoStart, { text: "where is #7?" });
    const control = executionControlOf(app);
    if (control === undefined) throw new Error("no execution control");

    const state = await control.executionStateOf({
      tenantId: result.tenantId,
      rootExecutionId: result.executionId,
      threadId: result.threadId,
    });

    expect(result.spend.totalUsd).toBeGreaterThanOrEqual(MEMORY_UPDATE_COST);
    expect(state).toMatchObject({ status: DurableExecutionStatus.Finished });
    expect(state.status === DurableExecutionStatus.Finished && state.spentUsd).toBeCloseTo(
      result.spend.totalUsd,
    );
    expect(durableStatusOf(state)?.spentUsd).toBeCloseTo(result.spend.totalUsd);
  });

  it("the record's cost once it answered, else the checkpoint's (its record gone, or not ended)", () => {
    const record = (status: ExecutionRecordStatus) => ({ status, costUsd: 3 });

    expect(finishedSpendOf(record(ExecutionRecordStatus.Answered), 2)).toBe(3);
    expect(finishedSpendOf(record(ExecutionRecordStatus.Running), 2)).toBe(2);
    expect(finishedSpendOf(undefined, 2)).toBe(2);
  });
});
