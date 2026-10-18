import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/index.js";
import {
  BudgetExceededError,
  NotPausedError,
  ThreadOwnerError,
  UnknownThreadError,
} from "../../src/errors.js";
import { NotAWorkflowStartError, type RunRejectedEvent } from "../../src/index.js";
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
import { Redeem, VoucherClerk, VouchersApplication } from "./fixtures/run-rejected.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true, by: "dana" };
const alice = { ownerId: "alice" };
const mallory = { ownerId: "mallory" };
const test = testWith(ApplicationsApplication);
const vouchers = testWith(VouchersApplication);

beforeEach(resetEvents);

/** The one refusal the observer saw: operation, thread, code — and nothing that names a run. */
function expectRejected(
  expected: Pick<RunRejectedEvent, "operation" | "code"> & { threadId?: string },
  hidden: readonly string[] = [],
): RunRejectedEvent {
  expect(rejections).toHaveLength(1);
  const event = rejections[0];
  if (event === undefined) throw new Error("no onRunRejected event");
  const thread = expected.threadId === undefined ? {} : { threadId: expected.threadId };
  expect(event).toEqual({ ...expected, message: expect.any(String), state: thread });
  expect(event.state).not.toHaveProperty("runId");
  for (const secret of hidden) expect(JSON.stringify(event)).not.toContain(secret);
  return event;
}

describe("#246 AC1: a thread of another owner → onRunRejected run.thread-owner, no runId", () => {
  test("execute on alice's thread as mallory: rejected before any run event", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));
    const first = await execute(app, Ask, { text: "one" }, alice);
    resetEvents();

    const again = execute(app, Ask, { text: "two" }, { threadId: first.threadId, ...mallory });

    await expect(again).rejects.toBeInstanceOf(ThreadOwnerError);
    expectRejected({ operation: "execute", threadId: first.threadId, code: "run.thread-owner" }, [
      first.runId,
      "alice",
      "mallory",
      "two",
    ]);
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

    await expect(app.resume(paused.threadId, approve, mallory)).rejects.toThrow(ThreadOwnerError);
    expectRejected({ operation: "resume", threadId: paused.threadId, code: "run.thread-owner" }, [
      paused.runId,
      "dana",
    ]);
    resetEvents();
    await expect(app.cancel(paused.threadId, mallory)).rejects.toThrow(ThreadOwnerError);
    expectRejected({ operation: "cancel", threadId: paused.threadId, code: "run.thread-owner" }, [
      paused.runId,
    ]);
    expect(workflowEvents()).toEqual([]);

    const done = await app.resume(paused.threadId, approve, alice);
    expect(done).toMatchObject({ status: ExecutionStatus.Finished, runId: paused.runId });
  });
});

describe("#246 AC2: nothing to resume, an unknown thread, an invalid start → onRunRejected", () => {
  test("resume of a run that already finished: run.not-paused", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "Done." }));
    const done = await execute(app, Ask, { text: "look" });
    resetEvents();

    await expect(app.resume(done.threadId, approve)).rejects.toBeInstanceOf(NotPausedError);
    expectRejected({ operation: "resume", threadId: done.threadId, code: "run.not-paused" }, [
      done.runId,
      "dana",
    ]);
    expect(workflowEvents()).toEqual([]);
  });

  test("resume of a thread nobody started: run.not-paused", async ({ app }) => {
    await expect(app.resume("no-such-thread", approve)).rejects.toBeInstanceOf(NotPausedError);
    expectRejected({ operation: "resume", threadId: "no-such-thread", code: "run.not-paused" });
  });

  test("execute on an unknown thread: run.unknown-thread, before onWorkflowStart", async ({
    app,
  }) => {
    const run = execute(app, Ask, { text: "hello" }, { threadId: "no-such-thread" });

    await expect(run).rejects.toBeInstanceOf(UnknownThreadError);
    expectRejected({
      operation: "execute",
      threadId: "no-such-thread",
      code: "run.unknown-thread",
    });
    expect(workflowEvents()).toEqual([]);
  });

  test("execute from a class that is not a start of the workflow: workflow.not-a-start", async ({
    app,
  }) => {
    const run = execute(app, Redeem, { text: "hi", code: "V-1" });

    await expect(run).rejects.toBeInstanceOf(NotAWorkflowStartError);
    expectRejected({ operation: "execute", code: "workflow.not-a-start" });
  });

  vouchers(
    "an invalid start input: dto.invalid naming the field, never its value",
    async ({ app }) => {
      const input = { text: "redeem my gift please", code: "SECRET-4471" };

      const run = execute(app, Redeem, input);

      await expect(run).rejects.toBeInstanceOf(DtoValidationError);
      // the caller still gets the whole error, value included
      await expect(run).rejects.toThrow(/SECRET-4471/);
      const event = expectRejected({ operation: "execute", code: "dto.invalid" }, [
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
    "the next execution never starts: onRunRejected with limit.budget, no start, no model call",
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
      expectRejected({ operation: "execute", code: "limit.budget" });
      expect(workflowEvents()).toEqual([]);
      expect(mockLlm(VoucherClerk).requests).toHaveLength(1);
    },
  );
});
