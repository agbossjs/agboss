/**
 * #1356 — the frame an execution's budgets are read in (#261 PR 5): `maxSpend()` reads the context of the
 * execution before its first step — its ids, its tenant, its workflow and the start step —; a thread that
 * does not exist yet cannot be read there, one the execution continues can.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  BriefFinish,
  BriefStart,
  BriefWorkflow,
  DrafterAgent,
  ReviewerAgent,
} from "./fixtures/budgets.application.js";
import { FrameApplication, frameReads } from "./fixtures/start-frame.application.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { DraftDto } from "./fixtures/budgets.application.js";

const test = testWith(FrameApplication);

/** The tenant's own field, as a tenant of the application passes it. */
const acme = { tenantId: "acme", dailyBudgetUsd: 5 };

beforeEach(() => {
  frameReads.length = 0;
});

describe("#1356: the frame of the start in which maxSpend() is read", () => {
  test("holds the execution's own ids, tenant, workflow and the start step", async ({
    app,
    mockModel,
  }) => {
    mockModel(DrafterAgent).thenReturn(replyWith(DraftDto, { text: "a draft" }, { cost: usd(0) }));
    mockModel(ReviewerAgent).thenReturn(replyWith("fine", { cost: usd(0) }));

    const done = await execute(
      app,
      BriefStart,
      { text: "a brief" },
      {
        threadId: "thread-1",
        ownerId: "owner-1",
        tenant: acme,
      },
    );

    expect(done).toFinishWith(BriefFinish, { text: "fine" });
    expect(frameReads).toHaveLength(1);
    const [read] = frameReads;
    expect(read).toMatchObject({
      executionId: done.executionId,
      ownerId: "owner-1",
      tenantId: "acme",
      tenantOwn: true,
      tenantDailyBudgetUsd: 5,
      aborted: false,
      workflow: { name: "brief-workflow", version: "1.0.0", startedVersion: "1.0.0" },
      thread: "thread-1",
      step: {
        nodeId: "brief-workflow-start",
        visitNumber: 1,
        idempotencyKey: `${done.executionId}:brief-workflow-start:1`,
        callId: undefined,
        itemIndex: undefined,
        copyNumber: 1,
        toolLoopIteration: undefined,
        validationAttempts: 0,
        componentName: "brief-workflow-start",
      },
    });
    expect(read?.workflowType).toBe(BriefWorkflow);
    expect(read?.workflow.configHash).toMatch(/^[0-9a-f]{8,}$/);
    expect(read?.step.componentType).toBe(BriefStart);
  });

  test("a thread that does not exist yet cannot be read there", async ({ app, mockModel }) => {
    mockModel(DrafterAgent).thenReturn(replyWith(DraftDto, { text: "a draft" }, { cost: usd(0) }));
    mockModel(ReviewerAgent).thenReturn(replyWith("fine", { cost: usd(0) }));

    const done = await execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

    expect(frameReads[0]?.thread).toBe(
      `the thread of execution ${done.executionId} was read in maxSpend(): it is a new thread, created only once the execution's budgets pass — read threadId in a step`,
    );
  });
});
