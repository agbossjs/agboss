/**
 * #401 PR 1 — the history of root executions: with `@Application({ executionRecordRetention })` each
 * root's `ExecutionHistoryRecord` is saved when its tree rests or ends — its record with who and what
 * it was (ids, application, workflow, start and input, finish and output, times, contexts, tool calls,
 * steps), masked like its traces — and removed by the recovery sweep once it ended longer ago than
 * that; without it nothing is kept.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionHistoryRepository, ExecutionHistoryStatus, type App } from "../../src/index.js";

import { TEST_START } from "../../src/testing/clock.js";
import {
  callTool,
  failWith,
  ModelFailure,
  replyWith,
  routeTo,
  testWith,
} from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import {
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  EvalDeskApplication,
  GetOrderTool,
  RefundTool,
} from "../flow/fixtures/eval-desk.fixture.js";
import {
  BrokenHistoryDeskApplication,
  EndOrderDeskApplication,
  endOrder,
  HistoryDeskApplication,
  HistorySensitiveApplication,
  HistoryTreasuryApplication,
} from "../flow/fixtures/execution-history.fixture.js";
import {
  PayOutTool,
  replyDesk,
  resetReplyDesk,
  TreasurerAgent,
  TreasuryWorkflowStart,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { DeskRouter, DeskStart, HandOverFinish } from "../pii/sensitive.fixture.js";

beforeEach(() => {
  resetReplyDesk();
  resetLogged();
});

const contexts = {
  tenant: { tenantId: "acme", plan: "pro" },
  execution: { userId: "u-1" },
} as const;

const REFUND = "Refund order 7 and write to dana@example.com";

/** The refund the desk makes: the order looked up, refunded, answered. */
const refundScript = [
  callTool(GetOrderTool, { orderId: "7" }),
  callTool(RefundTool, { orderId: "7", amountCents: 5000 }),
  replyWith(DeskAnswerDto, { text: "Refunded order 7." }),
] as const;

/** The history store of an app. */
const historyOf = (app: Pick<App, "resolve">): ExecutionHistoryRepository =>
  app.resolve(ExecutionHistoryRepository);

describe("#401 PR 1: the history of root executions", () => {
  testWith(HistoryDeskApplication)(
    "a finished execution: its record with who and what it was, masked",
    async ({ app, mockLlm }) => {
      mockLlm(DeskAgent).thenReturn(...refundScript);

      const done = await execute(app, DeskWorkflowStart, { text: REFUND }, contexts);
      const kept = await historyOf(app).findByTenantIdAndExecutionId("acme", done.executionId);

      expect(kept).toMatchObject({
        executionId: done.executionId,
        rootExecutionId: done.executionId,
        threadId: done.threadId,
        tenantId: "acme",
        application: { name: "history-desk-application", version: "1.0.0" },
        workflow: { name: "eval-desk-workflow", version: "1.0.0", startedVersion: "1.0.0" },
        status: ExecutionHistoryStatus.Finished,
        startedAt: TEST_START,
        endedAt: TEST_START,
        start: { name: "desk-workflow-start" },
        input: { text: "Refund order 7 and write to <email>" },
        finish: { name: "desk-workflow-finish" },
        output: { text: "Refunded order 7." },
        contexts: { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u-1" } },
        path: done.path,
      });
      expect(kept?.toolCalls.map((call) => call.step.component.name)).toEqual([
        "get-order-tool",
        "refund-tool",
      ]);
      expect(kept?.steps.map((step) => step.step.component.name)).toContain("desk-agent");
      expect(JSON.stringify(kept)).not.toContain("dana@example.com");
    },
  );

  testWith(EvalDeskApplication)(
    "without executionRecordRetention nothing is kept",
    async ({ app, mockLlm }) => {
      mockLlm(DeskAgent).thenReturn(...refundScript);
      const { tenant, execution } = contexts;

      const done = await execute(app, DeskWorkflowStart, { text: REFUND }, { tenant, execution });

      expect(await historyOf(app).findAllByExecutionId(done.executionId)).toEqual([]);
    },
  );

  testWith(HistoryDeskApplication)(
    "a failed execution is kept failed, with its error",
    async ({ app, mockLlm }) => {
      mockLlm(DeskAgent).thenReturnAlways(failWith(ModelFailure.Timeout));

      await expect(execute(app, DeskWorkflowStart, { text: REFUND }, contexts)).rejects.toThrow();
      const [kept] = await historyOf(app).findAllByStartedAtBetween(
        new Date(0),
        new Date("2100-01-01T00:00:00.000Z"),
        { offset: 0, limit: 10 },
      );

      expect(kept?.status).toBe(ExecutionHistoryStatus.Failed);
      expect(kept?.error?.code).toEqual(expect.any(String));
      expect(kept?.endedAt).toBe(TEST_START);
    },
  );

  testWith(HistoryDeskApplication)(
    "the sweep removes a record once it ended longer ago than its retention",
    async ({ app, clock, mockLlm }) => {
      mockLlm(DeskAgent).thenReturn(...refundScript);
      const done = await execute(app, DeskWorkflowStart, { text: REFUND }, contexts);

      await clock.advance(hours(23));
      expect(await historyOf(app).findAllByExecutionId(done.executionId)).toHaveLength(1);
      await clock.advance("3631s");

      expect(await historyOf(app).findAllByExecutionId(done.executionId)).toEqual([]);
    },
  );
});

testWith(BrokenHistoryDeskApplication)(
  "#401 PR 1: a history that cannot be saved is a warning, never the execution's failure",
  async ({ app, mockLlm }) => {
    mockLlm(DeskAgent).thenReturn(...refundScript);

    const done = await execute(app, DeskWorkflowStart, { text: REFUND }, contexts);

    expect(done.output).toEqual({ text: "Refunded order 7." });
    expect(logged.map((entry) => entry.code)).toContain("execution-history.failed");
  },
);

testWith(HistorySensitiveApplication)(
  "#401 PR 1: a context field marked sensitive is hidden in the history",
  async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(HandOverFinish));

    const done = await execute(
      app,
      DeskStart,
      { text: "hi" },
      { execution: { userId: "u-98765" } },
    );
    const kept = await historyOf(app).findByTenantIdAndExecutionId("default", done.executionId);

    expect(kept?.status).toBe(ExecutionHistoryStatus.Finished);
    expect(kept?.contexts.execution).toHaveProperty("userId");
    expect(JSON.stringify(kept)).not.toContain("u-98765");
  },
);

describe("#401 PR 1: a paused tree's history", () => {
  /** The payout's pause id: the desk channel's only ask. */
  const pauseIdOf = (): string => {
    const [ask] = replyDesk.asks;
    if (ask === undefined) throw new Error("the desk was not asked");
    return ask.pauseId;
  };

  testWith(HistoryTreasuryApplication)(
    "kept paused while it rests (no end, never swept), then finished with who answered",
    async ({ app, clock, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(
        callTool(PayOutTool, { payee: "ann", amountCents: 1000 }),
        replyWith("Paid."),
      );
      const paused = await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
      const history = historyOf(app);

      const resting = await history.findByTenantIdAndExecutionId("default", paused.executionId);
      expect(resting?.status).toBe(ExecutionHistoryStatus.Paused);
      expect(resting?.endedAt).toBeUndefined();
      await clock.advance(hours(25));
      expect(await history.findAllByExecutionId(paused.executionId)).toHaveLength(1);

      await app.resume(
        { pauseId: pauseIdOf(), decision: { approved: true } },
        { answeredBy: "manager-17" },
      );
      const ended = await history.findByTenantIdAndExecutionId("default", paused.executionId);

      expect(ended).toMatchObject({
        status: ExecutionHistoryStatus.Finished,
        startedAt: TEST_START,
        endedAt: "2026-01-06T10:00:00.000Z",
        pauses: [{ responder: "manager-17" }],
      });
    },
  );

  testWith(HistoryTreasuryApplication)(
    "a paused tree cancelled is kept cancelled",
    async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1000 }));
      const paused = await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

      await app.cancel(paused.threadId, {});
      const kept = await historyOf(app).findByTenantIdAndExecutionId("default", paused.executionId);

      expect(kept?.status).toBe(ExecutionHistoryStatus.Cancelled);
      expect(kept?.error?.code).toBe("execution.cancelled");
    },
  );
});

testWith(EndOrderDeskApplication)(
  "#699: a tree's kept record is saved before the tree is forgotten — a pod killed in the cleanup keeps it",
  async ({ app, mockLlm }) => {
    endOrder.length = 0;
    mockLlm(DeskAgent).thenReturn(...refundScript);

    await execute(app, DeskWorkflowStart, { text: REFUND }, contexts);
    mockLlm(DeskAgent).thenReturn(failWith(ModelFailure.BadRequest));
    await execute(app, DeskWorkflowStart, { text: REFUND }, contexts).catch(() => undefined);

    expect(endOrder).toEqual(["history finished", "forgotten", "history failed", "forgotten"]);
  },
);
