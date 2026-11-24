/**
 * #1341c — a tree parked by `app.pause` whose `app.unpause` died between its two writes: the freeze
 * is lifted on the lease row, the record is still `paused`, no pause is pending and no answer waits —
 * nothing says the tree has work. The recovery sweep's orphan look finds it by its status, marks it
 * `running` under its lease, and recovery continues it from its checkpoint once (on the test's
 * `VirtualClock`: the sweep runs when the test advances it). A tree still frozen is left alone.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseRepository, ExecutionRecordRepository } from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { SWEEP_EVERY } from "../../src/infrastructure/recovery.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
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

describe("#1341c: the sweep wakes a parked root an unpause died on", () => {
  test("the freeze lifted and the record still `paused`: one sweep marks it running and its pass finishes it, once", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(GateAgent).thenReturn(callTool(Gate, { text: "a" }), replyWith(NoteDto, { text: "x" }));
    const started = begun();
    const run = execute(app, GateStart, { text: "go" });
    const threadId = await started;
    await app.pause(threadId);
    stopSeen.open?.();
    const parked = await run;
    const tree = { tenantId: "default", rootExecutionId: parked.executionId };
    const records = app.resolve(ExecutionRecordRepository);
    expect(parked).toMatchObject({ status: ExecutionStatus.Paused, isExternallyPaused: true });

    // a sweep while the freeze stands wakes nothing
    await clock.advance(SWEEP_EVERY);
    expect((await records.lastTurns("default", threadId, 1))[0]?.status).toBe("paused");
    expect(stopSeen.payments).toEqual([]);

    // the unpause that died after it cleared the mark and before it marked the record `running`
    await app.resolve(ExecutionLeaseRepository).unpause(tree);
    expect((await records.lastTurns("default", threadId, 1))[0]?.status).toBe("paused");
    // the first sweep marks it `running`, the next one recovers it
    await clock.advance(SWEEP_EVERY);
    await clock.advance(SWEEP_EVERY);
    let answered = false;
    await until(() => {
      void records.lastTurns("default", threadId, 1).then((turns) => {
        answered = turns[0]?.status === "answered";
      });
      return answered;
    }, "the woken tree finished");

    expect(stopSeen.payments).toEqual([parked.executionId]);
    const history = await app.getStatusHistory(threadId);
    expect(history.map((row) => row.toStatus)).toEqual([
      "running",
      "pausing",
      "externally-paused",
      "running",
      "finished",
    ]);
    expect(history[3]).toMatchObject({ trigger: "unpause" });
  });
});
