import { beforeEach, describe, expect } from "vitest";
import { ExecutionRecordRepository } from "../../src/index.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  InterruptMode,
  PauseRequestState,
  StopRequestState,
} from "../../src/app/interrupt-types.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  KeptCheckoutApplication,
  Probe,
  ReceiptDto,
  resetSeen,
  seen,
  Start,
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

const begun = (): Promise<string> =>
  new Promise<string>((resolve) => {
    stopSeen.started = resolve;
  });

const statusesOf = async (
  app: { getStatusHistory(thread: string): Promise<readonly { readonly toStatus: string }[]> },
  thread: string,
): Promise<string[]> => (await app.getStatusHistory(thread)).map((row) => row.toStatus);

/** #1341c: `app.pause` parks an execution where it stands, `app.unpause` continues it from its checkpoint. */
describe("#1341c: app.pause / app.unpause of a running execution", () => {
  test("an AfterStep pause lets the step in flight finish, starts none after it: the call resolves Paused (isExternallyPaused), the record is `paused`, nothing is undone", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(
      callTool(Gate, { text: "a" }),
      replyWith(NoteDto, { text: "x" }),
    );
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    const asked = await app.pause(threadId, { reason: "maintenance" });
    // the step in flight was not told to abort
    expect(stopSeen.cleanups).toEqual([]);
    stopSeen.open?.();
    const output = await run;

    expect(asked).toEqual({ state: PauseRequestState.Pausing });
    expect(output).toMatchObject({
      status: ExecutionStatus.Paused,
      isExternallyPaused: true,
      reason: "maintenance",
      pending: [],
      threadId,
    });
    expect(stopSeen.payments).toEqual([]);
    const [record] = await app
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, threadId, 1);
    expect(record?.status).toBe("paused");
    expect(await statusesOf(app, threadId)).toEqual(["running", "pausing", "externally-paused"]);
    const history = await app.getStatusHistory(threadId);
    expect(history[1]).toMatchObject({ trigger: "pause", reason: "maintenance" });
  });

  test("an Immediate pause aborts the step in flight (its cleanups told `paused`) and parks the tree; unpause continues it from the checkpoint and finishes", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(
      callTool(Gate, { text: "a" }),
      replyWith(NoteDto, { text: "x" }),
    );
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    const asked = await app.pause(threadId, { mode: InterruptMode.Immediate });
    const parked = await run;

    expect(asked).toEqual({ state: PauseRequestState.Pausing });
    expect(parked).toMatchObject({ status: ExecutionStatus.Paused, isExternallyPaused: true });
    expect(stopSeen.payments).toEqual([]);
    // the aborted step's cleanups ran awaited, newest first, told `paused` (never `stopped`)
    expect(stopSeen.cleanups).toEqual([
      `third:paused:${parked.executionId}`,
      "second:paused",
      "first:paused",
    ]);
    stopSeen.cleanups.length = 0;

    // the parked tree continues once, from its checkpoint, on a token above the fence
    const next = begun();
    const resumed = app.unpause(threadId, { reason: "back" });
    await next;
    stopSeen.open?.();
    const done = await resumed;

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.executionId).toBe(parked.executionId);
    expect(stopSeen.payments).toEqual([parked.executionId]);
    expect(await statusesOf(app, threadId)).toEqual([
      "running",
      "pausing",
      "externally-paused",
      "running",
      "finished",
    ]);
    const history = await app.getStatusHistory(threadId);
    expect(history[3]).toMatchObject({ trigger: "unpause", reason: "back" });
  });

  test("a repeated pause writes the mark again and adds no history row; a pause of a parked tree is Paused", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(
      callTool(Gate, { text: "a" }),
      replyWith(NoteDto, { text: "x" }),
    );
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    await app.pause(threadId);
    await app.pause(threadId, { reason: "again" });
    stopSeen.open?.();
    await run;

    expect(await app.pause(threadId)).toEqual({ state: PauseRequestState.Paused });
    expect(await statusesOf(app, threadId)).toEqual(["running", "pausing", "externally-paused"]);
  });

  test("a pause of a thread that finished or never ran is NotRunning; unpause of one that is not paused is PauseError.NotPaused", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(
      callTool(Gate, { text: "a" }),
      replyWith(NoteDto, { text: "x" }),
    );
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    const refused = await app.unpause(threadId).catch((error: unknown) => error);
    stopSeen.open?.();
    await run;

    expect(refused).toBeInstanceOf(PauseError.NotPaused);
    expect(await app.pause(threadId)).toEqual({ state: PauseRequestState.NotRunning });
    const ended = await app.unpause(threadId).catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(ExecutionError.AlreadyTerminal);
  });

  test("a parked tree can be stopped, and cancelled: Cancel > Stop > Pause, each ends it where it rests", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    await app.pause(threadId, { mode: InterruptMode.Immediate });
    await run;

    const stopped = await app.stop(threadId, { reason: "never mind" });

    expect(stopped).toEqual({ state: StopRequestState.Stopped });
    expect(await statusesOf(app, threadId)).toEqual([
      "running",
      "pausing",
      "externally-paused",
      "stopping",
      "stopped",
    ]);
    const refused = await app.pause(threadId).catch((error: unknown) => error);
    expect(refused).toEqual({ state: PauseRequestState.NotRunning });
  });

  test("a parked tree is cancelled: the cancel takes the lease at a token above the pause's fence", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    await app.pause(threadId, { mode: InterruptMode.Immediate });
    await run;

    const cancelled = await app.cancel(threadId, { reason: "withdrawn" });

    expect(cancelled).toEqual({ cancelled: true });
    expect((await statusesOf(app, threadId)).at(-1)).toBe("cancelled");
  });
});

describe("#1341c: cancel while the pause is still parking", () => {
  test("pause(Immediate) then cancel at once: the run resolves Cancelled, never rejected with a fence, and the stale step stays fenced", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    await app.pause(threadId, { mode: InterruptMode.Immediate });
    await app.cancel(threadId, { reason: "withdrawn" });
    const output = await run;

    expect(output).toMatchObject({ status: ExecutionStatus.Cancelled, reason: "withdrawn" });
    expect(stopSeen.payments).toEqual([]);
    expect((await statusesOf(app, threadId)).at(-1)).toBe("cancelled");
  });

  test("stop(Immediate) after pause(Immediate): Stopped, Cancel > Stop > Pause", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    await app.pause(threadId, { mode: InterruptMode.Immediate });
    await app.stop(threadId, { mode: InterruptMode.Immediate });
    const output = await run;

    expect(output.status).toBe(ExecutionStatus.Stopped);
    expect((await statusesOf(app, threadId)).at(-1)).toBe("stopped");
  });

  test("a pause on a thread being cancelled is refused with ExecutionError.AlreadyTerminal", async ({
    app,
    mockModel,
  }) => {
    mockModel(GateAgent).thenReturn(callTool(Gate, { text: "a" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;

    await app.cancel(threadId);
    const refused = await app.pause(threadId).catch((error: unknown) => error);
    await run;

    expect(refused).toBeInstanceOf(ExecutionError.AlreadyTerminal);
  });
});

const kept = testWith(KeptCheckoutApplication);
const approve = { approved: true };

/** A tree that rests at a business pause is frozen too (`dual_paused`): `app.unpause` lifts only the operator's freeze. */
describe("#1341c: app.pause of a tree resting at a business pause", () => {
  kept(
    "is dual_paused: an answer is refused until the unpause, then accepted",
    async ({ app, mockModel }) => {
      mockModel(Clerk).thenReturn(
        callTool(Probe, { text: "card" }),
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Charged." }),
      );
      const paused = await execute(app, Start, { text: "charge" });

      const asked = await app.pause(paused.threadId, { reason: "freeze" });
      const refused = await app.resume(answerOf(paused, approve)).catch((error: unknown) => error);

      expect(asked).toEqual({ state: PauseRequestState.Paused });
      expect(refused).toBeInstanceOf(ExecutionError.ExternallyPaused);
      expect(seen.charges).toEqual([]);
      const lifted = await app.unpause(paused.threadId, { reason: "thaw" });
      expect(lifted).toMatchObject({ status: ExecutionStatus.Paused, isExternallyPaused: false });
      const done = await app.resume(answerOf(paused, approve));
      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(seen.charges).toHaveLength(1);
      expect(await statusesOf(app, paused.threadId)).toEqual([
        "running",
        "paused",
        "dual-paused",
        "paused",
        "running",
        "finished",
      ]);
    },
  );
});
