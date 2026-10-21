import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/index.js";
import {
  BudgetExceededError,
  InvalidThreadIdError,
  NotPausedError,
  ThreadOwnerError,
  UnknownPauseError,
  UnknownThreadError,
} from "../../src/errors.js";
import {
  ExecutionOperation,
  NotAWorkflowStartError,
  type ExecutionRejectedEvent,
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

describe("#246 AC1: a thread of another owner → onExecutionRejected run.thread-owner, no runId", () => {
  test("execute on alice's thread as mallory: rejected before any run event", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));
    const first = await execute(app, Ask, { text: "one" }, alice);
    resetEvents();

    const again = execute(app, Ask, { text: "two" }, { threadId: first.threadId, ...mallory });

    await expect(again).rejects.toBeInstanceOf(ThreadOwnerError);
    expectRejected(
      { operation: ExecutionOperation.Execute, threadId: first.threadId, code: "run.thread-owner" },
      [first.executionId, "alice", "mallory", "two"],
    );
    expect(workflowEvents()).toEqual([]);
  });

  test("resume and cancel of alice's paused run as mallory: rejected, the run stays paused", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );
    const paused = await execute(app, Ask, { text: "apply" }, alice);
    resetEvents();

    await expect(app.resume(answerOf(paused, approve), mallory)).rejects.toThrow(ThreadOwnerError);
    expectRejected(
      { operation: ExecutionOperation.Resume, threadId: paused.threadId, code: "run.thread-owner" },
      [paused.executionId, "dana"],
    );
    resetEvents();
    await expect(app.cancel(paused.threadId, mallory)).rejects.toThrow(ThreadOwnerError);
    expectRejected(
      { operation: ExecutionOperation.Cancel, threadId: paused.threadId, code: "run.thread-owner" },
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
  test("#267: a second answer to a pause its run already took: run.not-paused", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );
    const paused = await execute(app, Ask, { text: "apply" });
    const done = await app.resume(answerOf(paused, approve));
    resetEvents();

    await expect(app.resume(answerOf(paused, approve))).rejects.toBeInstanceOf(NotPausedError);
    expectRejected(
      { operation: ExecutionOperation.Resume, threadId: done.threadId, code: "run.not-paused" },
      [done.executionId],
    );
    expect(workflowEvents()).toEqual([]);
  });

  test("#267 AC2: a pause nobody made: pause.unknown, no thread named", async ({ app }) => {
    const unknown = app.resume({ pauseId: "no-such-pause", decision: approve });

    await expect(unknown).rejects.toBeInstanceOf(UnknownPauseError);
    expectRejected({ operation: ExecutionOperation.Resume, code: "pause.unknown" });
  });

  test("execute with an id that cannot be a thread: run.invalid-thread-id, before onWorkflowStart", async ({
    app,
  }) => {
    // an id the tenant does not have yet is the caller's own new thread (#262 Q4); a bad one is not
    const run = execute(app, Ask, { text: "hello" }, { threadId: "bad\nid" });

    await expect(run).rejects.toBeInstanceOf(InvalidThreadIdError);
    expectRejected({
      operation: ExecutionOperation.Execute,
      threadId: "bad\nid",
      code: "run.invalid-thread-id",
    });
    expect(workflowEvents()).toEqual([]);
  });

  test("cancel of an unknown thread: run.unknown-thread", async ({ app }) => {
    await expect(app.cancel("no-such-thread")).rejects.toBeInstanceOf(UnknownThreadError);
    expectRejected({
      operation: ExecutionOperation.Cancel,
      threadId: "no-such-thread",
      code: "run.unknown-thread",
    });
  });

  test("execute from a class that is not a start of the workflow: workflow.not-a-start", async ({
    app,
  }) => {
    const run = execute(app, Redeem, { text: "hi", code: "V-1" });

    await expect(run).rejects.toBeInstanceOf(NotAWorkflowStartError);
    expectRejected({ operation: ExecutionOperation.Execute, code: "workflow.not-a-start" });
  });

  vouchers(
    "an invalid start input: dto.invalid naming the field, never its value",
    async ({ app }) => {
      const input = { text: "redeem my gift please", code: "SECRET-4471" };

      const run = execute(app, Redeem, input);

      await expect(run).rejects.toBeInstanceOf(DtoValidationError);
      // the caller still gets the whole error, value included
      await expect(run).rejects.toThrow(/SECRET-4471/);
      const event = expectRejected({ operation: ExecutionOperation.Execute, code: "dto.invalid" }, [
        input.code,
        input.text,
      ]);
      expect(event.message).toBe("invalid VoucherDto at code");
      expect(workflowEvents()).toEqual([]);
    },
  );
});

describe("#261 AC10: a tenant's day spent before the execution → it is rejected before its first step", () => {
  vouchers(
    "the next execution never starts: onExecutionRejected with limit.budget, no start, no model call",
    async ({ app, mockLlm }) => {
      mockLlm(VoucherClerk).thenReturn(
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
      expect(mockLlm(VoucherClerk).requests).toHaveLength(1);
    },
  );
});

/** No thread was created: the first id the store would hand out is still unknown. */
async function expectNoNewThread(app: Pick<TestApp, "cancel">): Promise<void> {
  await expect(app.cancel("thread-1")).rejects.toBeInstanceOf(UnknownThreadError);
}

describe("#261: a request refused before it starts leaves no trace — no thread, no record", () => {
  vouchers("a budget exhausted on a new thread", async ({ app, mockLlm, mockOf }) => {
    mockOf(VouchersTenantDailyBudget).maxSpend.mockReturnValue(usd(0));

    await expect(execute(app, Redeem, { text: "one", code: "V-1" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    await expectNoNewThread(app);
    expect(mockLlm(VoucherClerk).requests).toHaveLength(0);
    expect(workflowEvents()).toEqual([]);
  });

  vouchers("an invalid start input", async ({ app }) => {
    await expect(execute(app, Redeem, { text: "redeem", code: "BAD" })).rejects.toBeInstanceOf(
      DtoValidationError,
    );

    await expectNoNewThread(app);
  });

  vouchers("a later admitted execution gets the first thread", async ({ app, mockLlm, mockOf }) => {
    mockOf(VouchersTenantDailyBudget).maxSpend.mockReturnValueOnce(usd(0)).mockReturnValue(usd(1));
    mockLlm(VoucherClerk).thenReturn(replyWith(AnswerDto, { text: "Redeemed." }));

    await expect(execute(app, Redeem, { text: "one", code: "V-1" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    const admitted = await execute(app, Redeem, { text: "two", code: "V-2" });

    expect(admitted.threadId).toBe("thread-1");
  });
});
