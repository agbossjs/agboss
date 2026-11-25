import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError } from "../../src/errors.js";
import {
  ExecutionOperation,
  type ExecutionRejectedEvent,
  ValidationError,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  Apply,
  Ask,
  Clerk,
  rejections,
  resetEvents,
  workflowEvents,
  AnswerDto,
  ApplicationsApplication,
} from "./fixtures/run-events.workflow.js";
import {
  Redeem,
  VoucherClerk,
  VouchersApplication,
  VouchersTenantDailyBudget,
} from "./fixtures/run-rejected.workflow.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute, answerOf } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true };
const alice = { ownerId: "alice" };
const mallory = { ownerId: "mallory" };
const test = testWith(ApplicationsApplication);
const vouchers = testWith(VouchersApplication);

beforeEach(resetEvents);

/** The one refusal the observer saw: operation, thread, code — and nothing that names a run. */
function expectRejected(
  expected: Pick<ExecutionRejectedEvent, "operation" | "code"> & { threadId?: string },
  hidden: readonly string[] = [],
): ExecutionRejectedEvent {
  expect(rejections).toHaveLength(1);
  const event = rejections[0];
  if (event === undefined) throw new Error("no onExecutionRejected event");
  expect(event).toEqual({ tenantId: "default", ...expected, message: expect.any(String) });
  expect(event).not.toHaveProperty("executionId");
  for (const secret of hidden) expect(JSON.stringify(event)).not.toContain(secret);
  return event;
}

describe("#246 AC1: a thread of another owner → onExecutionRejected execution.thread-owner-mismatch, no runId", () => {
  test("execute on alice's thread as mallory: rejected before any run event", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));
    const first = await execute(app, Ask, { text: "one" }, alice);
    resetEvents();

    const again = execute(app, Ask, { text: "two" }, { threadId: first.threadId, ...mallory });

    await expect(again).rejects.toBeInstanceOf(ExecutionError.ThreadOwnerMismatch);
    expectRejected(
      {
        operation: ExecutionOperation.Execute,
        threadId: first.threadId,
        code: "execution.thread-owner-mismatch",
      },
      [first.executionId, "alice", "mallory", "two"],
    );
    expect(workflowEvents()).toEqual([]);
  });

  test("resume and cancel of alice's paused run as mallory: rejected, the run stays paused", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );
    const paused = await execute(app, Ask, { text: "apply" }, alice);
    resetEvents();

    await expect(app.resume(answerOf(paused, approve), mallory)).rejects.toThrow(
      ExecutionError.ThreadOwnerMismatch,
    );
    expectRejected(
      {
        operation: ExecutionOperation.Resume,
        threadId: paused.threadId,
        code: "execution.thread-owner-mismatch",
      },
      [paused.executionId, "dana"],
    );
    resetEvents();
    await expect(app.cancel(paused.threadId, mallory)).rejects.toThrow(
      ExecutionError.ThreadOwnerMismatch,
    );
    expectRejected(
      {
        operation: ExecutionOperation.Cancel,
        threadId: paused.threadId,
        code: "execution.thread-owner-mismatch",
      },
      [paused.executionId],
    );
    expect(workflowEvents()).toEqual([]);

    const done = await app.resume(answerOf(paused, approve), alice);
    expect(done).toMatchObject({
      status: ExecutionStatus.Finished,
      executionId: paused.executionId,
    });
  });
});

describe("#246 AC2: nothing to resume, an unknown thread, an invalid start → onExecutionRejected", () => {
  test("#267: a second answer to a pause its run already took: pause.closed", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );
    const paused = await execute(app, Ask, { text: "apply" });
    const done = await app.resume(answerOf(paused, approve));
    resetEvents();

    await expect(app.resume(answerOf(paused, approve))).rejects.toBeInstanceOf(PauseError.Closed);
    expectRejected(
      { operation: ExecutionOperation.Resume, threadId: done.threadId, code: "pause.closed" },
      [done.executionId],
    );
    expect(workflowEvents()).toEqual([]);
  });

  test("#267 AC2: a pause nobody made: pause.unknown-pause, no thread named", async ({ app }) => {
    const unknown = app.resume({ pauseId: "no-such-pause", decision: approve });

    await expect(unknown).rejects.toBeInstanceOf(PauseError.UnknownPause);
    expectRejected({ operation: ExecutionOperation.Resume, code: "pause.unknown-pause" });
  });

  test("execute with an id that cannot be a thread: execution.invalid-thread-id, before onWorkflowStart", async ({
    app,
  }) => {
    // an id the tenant does not have yet is the caller's own new thread (#262 Q4); a bad one is not
    const run = execute(app, Ask, { text: "hello" }, { threadId: "bad\nid" });

    await expect(run).rejects.toBeInstanceOf(ExecutionError.InvalidThreadId);
    // #538: an id refused for its text is never echoed: the event names the rule, not the id
    expectRejected({ operation: ExecutionOperation.Execute, code: "execution.invalid-thread-id" }, [
      "bad",
    ]);
    expect(workflowEvents()).toEqual([]);
  });

  test("cancel of an unknown thread: execution.unknown-thread", async ({ app }) => {
    await expect(app.cancel("no-such-thread")).rejects.toBeInstanceOf(ExecutionError.UnknownThread);
    expectRejected({
      operation: ExecutionOperation.Cancel,
      threadId: "no-such-thread",
      code: "execution.unknown-thread",
    });
  });

  test("execute from a class that is not a start of the workflow: config.not-a-workflow-start", async ({
    app,
  }) => {
    const run = execute(app, Redeem, { text: "hi", code: "V-1" });

    await expect(run).rejects.toBeInstanceOf(ConfigError.NotAWorkflowStart);
    expectRejected({ operation: ExecutionOperation.Execute, code: "config.not-a-workflow-start" });
  });

  vouchers(
    "an invalid start input: dto.invalid naming the field, never its value",
    async ({ app }) => {
      const input = { text: "redeem my gift please", code: "SECRET-4471" };

      const run = execute(app, Redeem, input);

      await expect(run).rejects.toBeInstanceOf(ValidationError.DtoInvalid);
      // the caller still gets the whole error, value included
      await expect(run).rejects.toThrow(/SECRET-4471/);
      const event = expectRejected(
        { operation: ExecutionOperation.Execute, code: "validation.dto-invalid" },
        [input.code, input.text],
      );
      expect(event.message).toBe("invalid VoucherDto at code");
      expect(workflowEvents()).toEqual([]);
    },
  );
});

describe("#261 AC10: a tenant's day spent before the execution → it is rejected before its first step", () => {
  vouchers(
    "the next execution never starts: onExecutionRejected with limit.budget, no start, no model call",
    async ({ app, mockModel }) => {
      mockModel(VoucherClerk).thenReturn(
        replyWith(AnswerDto, { text: "Too dear." }, { cost: usd(0.06) }),
      );
      // the execution's one reply spends more than the tenant's day allows
      await execute(app, Redeem, { text: "one", code: "V-1" });
      resetEvents();

      const run = execute(app, Redeem, { text: "two", code: "V-2" });

      await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(run).rejects.toThrow(
        "tenant default spent $0.06 today; vouchers-tenant-daily-budget allows $0.05",
      );
      expectRejected({ operation: ExecutionOperation.Execute, code: "limit.budget" });
      expect(workflowEvents()).toEqual([]);
      expect(mockModel(VoucherClerk).requests).toHaveLength(1);
    },
  );
});

/** No thread was created: the first id the store would hand out is still unknown. */
async function expectNoNewThread(app: Pick<TestApp, "cancel">): Promise<void> {
  await expect(app.cancel("thread-1")).rejects.toBeInstanceOf(ExecutionError.UnknownThread);
}

describe("#261: a request refused before it starts leaves no trace — no thread, no record", () => {
  vouchers("a budget exhausted on a new thread", async ({ app, mockModel, mockService }) => {
    mockService(VouchersTenantDailyBudget).maxSpend.mockReturnValue(usd(0));

    await expect(execute(app, Redeem, { text: "one", code: "V-1" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    await expectNoNewThread(app);
    expect(mockModel(VoucherClerk).requests).toHaveLength(0);
    expect(workflowEvents()).toEqual([]);
  });

  vouchers("an invalid start input", async ({ app }) => {
    await expect(execute(app, Redeem, { text: "redeem", code: "BAD" })).rejects.toBeInstanceOf(
      ValidationError.DtoInvalid,
    );

    await expectNoNewThread(app);
  });

  vouchers(
    "a later admitted execution gets the first thread",
    async ({ app, mockModel, mockService }) => {
      mockService(VouchersTenantDailyBudget)
        .maxSpend.mockReturnValueOnce(usd(0))
        .mockReturnValue(usd(1));
      mockModel(VoucherClerk).thenReturn(replyWith(AnswerDto, { text: "Redeemed." }));

      await expect(execute(app, Redeem, { text: "one", code: "V-1" })).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      const admitted = await execute(app, Redeem, { text: "two", code: "V-2" });

      expect(admitted.threadId).toBe("thread-1");
    },
  );
});
