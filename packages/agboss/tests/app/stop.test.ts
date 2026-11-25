import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseRepository, ExecutionRecordRepository } from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { InterruptMode, StopRequestState } from "../../src/app/interrupt-types.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  KeptCheckoutApplication,
  Probe,
  Start,
  resetSeen,
} from "./fixtures/run-context.workflow.js";
import {
  Gate,
  GateAgent,
  GateApplication,
  GateStart,
  NoteDto,
  stopSeen,
} from "./fixtures/stop.workflow.js";

const test = testWith(GateApplication);

beforeEach(() => {
  resetSeen();
  stopSeen.payments.length = 0;
  stopSeen.cleanups.length = 0;
  stopSeen.cleanupErrors.length = 0;
  delete stopSeen.open;
  delete stopSeen.started;
});

/** #1341b: `app.stop` halts an execution where it stands: its caller resolves `Stopped`, nothing is undone. */
describe("#1341b: app.stop", () => {
  const begun = (): Promise<string> =>
    new Promise<string>((resolve) => {
      stopSeen.started = resolve;
    });

  test("an Immediate stop aborts the step in flight: the call resolves Stopped with the reason, the next step never runs, the record is `stopped`", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    const stopped = await app.stop(threadId, { mode: InterruptMode.Immediate, reason: "enough" });
    const output = await run;

    expect(stopped).toEqual({ state: StopRequestState.Stopping });
    expect(output).toMatchObject({
      status: ExecutionStatus.Stopped,
      threadId,
      tenantId: DEFAULT_TENANT_ID,
      reason: "enough",
      pending: [],
    });
    expect(output.finish).toBeUndefined();
    expect(stopSeen.payments).toEqual([]);
    const [record] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, threadId, 1);
    expect(record).toMatchObject({ runId: output.executionId, status: "stopped" });
    const history = await app.getStatusHistory(threadId);
    expect(history.map((row) => row.toStatus)).toEqual(["running", "stopping", "stopped"]);
    expect(history[1]).toMatchObject({ trigger: "stop", reason: "enough" });
  });

  test("onInterrupted: an interrupted step's cleanups run awaited, newest first, told why; one that throws is reported and the rest still run — before the call resolves", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    await app.stop(threadId, { mode: InterruptMode.Immediate });
    const output = await run;

    expect(output.status).toBe(ExecutionStatus.Stopped);
    expect(stopSeen.cleanups).toEqual([
      `third:stopped:${output.executionId}`,
      "second:stopped",
      "first:stopped",
    ]);
    expect(stopSeen.cleanupErrors).toEqual([
      { reason: "stopped", message: "the cleanup failed", component: "gate-agent" },
    ]);
  });

  test("onInterrupted: nothing runs when the step ends normally", async ({ app, mockLlm }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }), replyWith(NoteDto, { text: "x" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    await started;

    stopSeen.open?.();
    const output = await run;

    expect(output.status).toBe(ExecutionStatus.Finished);
    expect(stopSeen.cleanups).toEqual([]);
    expect(stopSeen.cleanupErrors).toEqual([]);
  });

  test("an AfterStep stop lets the step in flight finish and commit, and starts no step after it", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }), replyWith(NoteDto, { text: "x" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    await app.stop(threadId, { reason: "wind down" });
    // the step in flight was not told to abort
    expect(stopSeen.open).toBeDefined();
    stopSeen.open?.();
    const output = await run;

    expect(output).toMatchObject({ status: ExecutionStatus.Stopped, reason: "wind down" });
    expect(stopSeen.payments).toEqual([]);
  });

  test("a stop of a thread that is not running is NotRunning, and a second stop of a stopped one changes nothing", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    await app.stop(threadId, { mode: InterruptMode.Immediate });
    await run;

    expect(await app.stop(threadId)).toEqual({ state: StopRequestState.NotRunning });
    expect(await app.cancel(threadId)).toEqual({ cancelled: false });
    const history = await app.getStatusHistory(threadId);
    expect(history.map((row) => row.toStatus)).toEqual(["running", "stopping", "stopped"]);
  });

  test("a finish never lands over a durable stop mark: a mark with no request key still ends the run Stopped, and its record is `stopped`", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }), replyWith(NoteDto, { text: "x" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    const tree = { tenantId: DEFAULT_TENANT_ID, rootExecutionId: stopSeen.executionId ?? "" };

    await app.resolve(ExecutionLeaseRepository).requestStop(tree, InterruptMode.AfterStep);
    stopSeen.open?.();
    const output = await run;

    expect(output.status).toBe(ExecutionStatus.Stopped);
    const [record] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, threadId, 1);
    expect(record?.status).toBe("stopped");
  });

  test("a durable cancel mark wins over a finish too: Cancel > Stop", async ({ app, mockLlm }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }), replyWith(NoteDto, { text: "x" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    await started;
    const tree = { tenantId: DEFAULT_TENANT_ID, rootExecutionId: stopSeen.executionId ?? "" };
    const leases = app.resolve(ExecutionLeaseRepository);

    await leases.requestStop(tree, InterruptMode.AfterStep);
    await leases.requestCancel(tree);
    stopSeen.open?.();

    expect((await run).status).toBe(ExecutionStatus.Cancelled);
  });

  test("a stop of an unknown thread is refused, never echoed", async ({ app }) => {
    const error = await app.stop("no-such-thread").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
  });
});

const approve = { approved: true };
const kept = testWith(KeptCheckoutApplication);

/** A paused execution has no step in flight: `app.stop` ends it at once, its open pause closed as the tree's end. */
describe("#1341b: app.stop of a paused execution", () => {
  kept(
    "ends it Stopped at once, closes its pause, keeps nothing undone",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Probe, { text: "card" }),
        callTool(Charge, { text: "10 USD" }),
      );
      const paused = await execute(app, Start, { text: "charge" }, { ownerId: "ops-1" });

      const asked = await app.stop(paused.threadId, { ownerId: "ops-1", reason: "not today" });

      expect(paused.status).toBe(ExecutionStatus.Paused);
      expect(asked).toEqual({ state: StopRequestState.Stopped });
      const [record] = await app
        .resolve(ExecutionRecordRepository)
        .lastTurns(DEFAULT_TENANT_ID, paused.threadId, 1);
      expect(record?.status).toBe("stopped");
      const history = await app.getStatusHistory(paused.threadId);
      expect(history.map((row) => row.toStatus)).toEqual([
        "running",
        "paused",
        "stopping",
        "stopped",
      ]);
      expect(history.at(-2)).toMatchObject({
        trigger: "stop",
        actor: "ops-1",
        reason: "not today",
      });
      expect(await app.stop(paused.threadId, { ownerId: "ops-1" })).toEqual({
        state: StopRequestState.NotRunning,
      });
      await expect(app.resume(answerOf(paused, approve))).rejects.toBeInstanceOf(Error);
    },
  );
});
