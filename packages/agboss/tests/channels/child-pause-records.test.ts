/**
 * #267 S124 c (PR 4): a child execution's record lists the pauses its own steps asked —
 * `ChildExecutionRecord.pauses`, in `result.children` and `result.record.children` alike — while the
 * root's `record.pauses` keeps the whole tree's. A single child (`.toWorkflow`) and a per-item one
 * (`.toParallelWorkflows`, one child per line, each pausing on its own).
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseResolution, type ChildExecutionRecord, type PendingPause } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  BatchSummaryAgent,
  BookExpenseTool,
  resetReplyDesk,
  TreasurerAgent,
  TreasuryApplication,
  TreasuryBatchWorkflowFinish,
  TreasuryBatchWorkflowStart,
  TreasuryDeskWorkflowFinish,
  TreasuryDeskWorkflowStart,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(TreasuryApplication);

beforeEach(resetReplyDesk);

const owner = { ownerId: "alice" };

/** A child's pending pause: its id and its child's execution (the test fails without them). */
interface ChildPause {
  readonly pauseId: string;
  readonly childExecutionId: string;
}

function childPauseOf(pause: PendingPause | undefined): ChildPause {
  const { pauseId, childExecutionId } = pause ?? {};
  if (pauseId === undefined || childExecutionId === undefined) throw new Error("no child pause");
  return { pauseId, childExecutionId };
}

const byItemIndex = (first: ChildExecutionRecord, second: ChildExecutionRecord): number =>
  (first.itemIndex ?? 0) - (second.itemIndex ?? 0);
const yes = '{"approved":true}';

describe("#267 S124 c: a single child's record lists its own pauses", () => {
  test("the child's pause is in its record, in result.children and in the root's record", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "taxi" }),
      replyWith("Booked."),
    );
    const paused = await execute(app, TreasuryDeskWorkflowStart, { text: "book a taxi" }, owner);
    const [pending] = paused.pending;

    const done = await app.resume(
      { pauseId: pending?.pauseId ?? "", reply: yes },
      { ...owner, record: true },
    );

    expect(done).toFinishWith(TreasuryDeskWorkflowFinish, { text: "Booked." });
    const [child] = done.children;
    const asked = {
      executionId: pending?.childExecutionId,
      role: "expense-approval-channel",
      resolution: PauseResolution.Replied,
      responder: "alice",
      decision: { approved: true },
    };
    expect(child?.executionId).toBe(pending?.childExecutionId);
    expect(child?.pauses).toMatchObject([asked]);
    expect(done.record?.children[0]?.pauses).toMatchObject([asked]);
    expect(done.record?.pauses).toMatchObject([asked]);
  });
});

describe("#267 S124 c: each per-item child's record lists its own pauses", () => {
  test("two children pause on their own: each record holds one, the root's holds both", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent)
      .when({ message: { text: "book lunch" } })
      .thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }), replyWith("Lunch booked."));
    mockLlm(TreasurerAgent)
      .when({ message: { text: "book a taxi" } })
      .thenReturn(callTool(BookExpenseTool, { purpose: "taxi" }), replyWith("Taxi booked."));
    mockLlm(BatchSummaryAgent).thenReturn(replyWith("Both booked."));
    const paused = await execute(
      app,
      TreasuryBatchWorkflowStart,
      { text: "book lunch\nbook a taxi" },
      owner,
    );
    const lunch = childPauseOf(paused.pending[0]);
    const taxi = childPauseOf(paused.pending[1]);

    await app.resume({ pauseId: lunch.pauseId, reply: yes }, owner);
    const done = await app.resume(
      { pauseId: taxi.pauseId, reply: '{"approved":false}' },
      { ...owner, record: true },
    );

    expect(done).toFinishWith(TreasuryBatchWorkflowFinish, { text: "Both booked." });
    const byItem = [...done.children].sort(byItemIndex);
    expect(byItem.map((child) => child.pauses)).toMatchObject([
      [
        {
          executionId: lunch.childExecutionId,
          step: { itemIndex: 0 },
          decision: { approved: true },
        },
      ],
      [
        {
          executionId: taxi.childExecutionId,
          step: { itemIndex: 1 },
          decision: { approved: false },
        },
      ],
    ]);
    expect(done.record?.children.map((child) => child.pauses.length)).toEqual([1, 1]);
    expect(done.record?.pauses.map((answer) => answer.executionId)).toEqual([
      lunch.childExecutionId,
      taxi.childExecutionId,
    ]);
  });
});
