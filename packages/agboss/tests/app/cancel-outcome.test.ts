import { beforeEach, describe, expect } from "vitest";
import { ExecutionRecordRepository } from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  blocking,
  Clerk,
  CheckoutApplication,
  resetSeen,
  seen,
  Start,
  Wait,
} from "./fixtures/run-context.workflow.js";

const test = testWith(CheckoutApplication);

beforeEach(resetSeen);

/** #1341: a cancel is an outcome of the call, not an error — and a record says so. */
describe("#1341: a cancelled execution resolves with ExecutionStatus.Cancelled", () => {
  test("the output names the execution and its thread, lists nothing pending and finished nothing; its record is `cancelled`", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const started = new Promise<string>((resolve) => {
      blocking.started = resolve;
    });
    const run = execute(app, Start, { text: "wait" });
    const threadId = await started;

    expect(await app.cancel(threadId)).toEqual({ cancelled: true });
    const output = await run;

    expect(output).toMatchObject({
      status: ExecutionStatus.Cancelled,
      threadId,
      tenantId: DEFAULT_TENANT_ID,
      pending: [],
    });
    expect(output.finish).toBeUndefined();
    expect(output.output).toBeUndefined();
    const [record] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, threadId, 1);
    expect(record).toMatchObject({ runId: output.executionId, status: "cancelled" });
    expect(seen.payments).toEqual([]);
  });

  test("a second cancel of it finds nothing to cancel, and never changes what the first said", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const started = new Promise<string>((resolve) => {
      blocking.started = resolve;
    });
    const run = execute(app, Start, { text: "wait" });
    const threadId = await started;
    await app.cancel(threadId);
    const first = await run;

    expect(await app.cancel(threadId)).toEqual({ cancelled: false });
    const [record] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, threadId, 1);

    expect(first.status).toBe(ExecutionStatus.Cancelled);
    expect(record?.status).toBe("cancelled");
  });
});

/** R7: a bad argument is a rejected promise, never a synchronous throw. */
describe("R7: the app's async methods reject, they never throw", () => {
  test("cancel, resume, setPauseTimeout, reassignPause and execute with an argument no one can use", async ({
    app,
  }) => {
    const calls: readonly (() => Promise<unknown>)[] = [
      () => app.cancel(7 as never),
      () => app.resume(null as never),
      () => app.setPauseTimeout(null as never),
      () => app.reassignPause(null as never),
      () => app.execute(null as never, {} as never),
    ];

    for (const call of calls) {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = call();
      }).not.toThrow();
      await expect(promise).rejects.toBeInstanceOf(Error);
    }
  });
});
