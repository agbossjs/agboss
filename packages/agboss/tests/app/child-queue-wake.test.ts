/**
 * #777 — a child queued in another process wakes a claimer through the store's watch
 * (`ChildExecutionQueueRepository.watchQueued`), not at its next sweep (AC1). The watch is a hint:
 * a wake-up lost leaves the child to the sweep, which still claims it (a lost notification never
 * loses work); a watch that does not open is warned and tried again at the next sweep; a wake-up
 * with no free slot asks the store nothing; the watch is closed when the instance stops (AC3).
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ChildExecutionQueueRepository } from "../../src/index.js";
import { SWEEP_EVERY } from "../../src/infrastructure/recovery.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { untilSettled } from "../metrics/support/runs.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  ClaimRoomBatchWorkflowFinish,
  ClaimRoomBatchWorkflowStart,
  releaseItem,
  resetRoomLog,
  roomItemsOf,
  roomLog,
} from "./fixtures/claim-room.workflow.js";
import {
  QueueWakeApplication,
  resetWakeLog,
  wake,
  wakeLog,
} from "./fixtures/queue-wake.application.js";

const test = testWith(QueueWakeApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetRoomLog();
  resetWakeLog();
  resetLogged();
});
afterEach(resetRoomLog);

/** Until `count` children are queued in the store (none claimed, they are hidden). */
async function untilQueued(app: TestApp, count: number): Promise<void> {
  const queue = app.resolve(ChildExecutionQueueRepository);
  await vi.waitFor(async () => {
    expect((await queue.countByStatus()).queued).toBe(count);
  });
  await settle();
}

/** Until the instance's claimers watch the queue: they open it before their first look. */
async function ready(app: TestApp): Promise<void> {
  await app.ready();
  await vi.waitFor(() => {
    expect(wakeLog.listeners.size).toBe(1);
  });
}

/** Opens every gate until the call ends. */
const finishAll = (call: Promise<unknown>, clock: Parameters<typeof untilSettled>[1]) =>
  untilSettled(call, clock, () => {
    for (const item of [...roomLog.gates.keys()]) releaseItem(item);
    return Promise.resolve();
  });

describe("#777 AC1: a child queued elsewhere is claimed on the store's wake-up", () => {
  test("the watch wakes the claimer: the child is at work at once, no sweep", async ({
    app,
    clock,
  }) => {
    await ready(app);
    expect(wakeLog.opened).toBe(1);
    wakeLog.isHidden = true;
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(2));
    await untilQueued(app, 2);
    expect(roomLog.atWork.size).toBe(0);

    wakeLog.isHidden = false; // the other process's rows are visible now: its notification comes
    wake();

    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(2);
    });
    await finishAll(call, clock);
    expect(await call).toFinishWith(ClaimRoomBatchWorkflowFinish, { text: "item-0, item-1" });
  });

  test("a wake-up lost: the sweep claims the child all the same", async ({ app, clock }) => {
    await ready(app);
    wakeLog.isHidden = true;
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(1));
    await untilQueued(app, 1);
    wakeLog.isHidden = false; // visible, but its notification never arrives

    await clock.advance(seconds(29)); // a second before the sweep (SWEEP_EVERY, 30 s)
    await settle();
    expect(roomLog.atWork.size).toBe(0);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(1);
    });
    await finishAll(call, clock);
    expect(await call).toFinishWith(ClaimRoomBatchWorkflowFinish, { text: "item-0" });
  });

  test("a wake-up with every slot busy asks the store nothing", async ({ app, clock }) => {
    await ready(app);
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(4));
    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(3);
    });
    await settle();
    const claims = wakeLog.claims;

    for (let notification = 0; notification < 5; notification += 1) wake();
    await settle();

    expect(wakeLog.claims).toBe(claims);
    await finishAll(call, clock);
    expect(roomLog.most).toBe(3);
  });

  test("the watch is closed when the instance stops", async ({ app }) => {
    await ready(app);

    await app.close();

    expect(wakeLog.closed).toBe(1);
    expect(wakeLog.listeners.size).toBe(0);
  });
});

describe("#777: a watch that does not open", () => {
  beforeEach(() => {
    wakeLog.failingOpens = 1;
  });

  test("is warned and opened again at the next sweep; the sweep claims meanwhile", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await settle();
    expect(wakeLog.opened).toBe(0);
    expect(logged.map((entry) => entry.code)).toContain("child-queue.watch-failed");

    await clock.advance(SWEEP_EVERY);
    await vi.waitFor(() => {
      expect(wakeLog.opened).toBe(1);
    });
    wakeLog.isHidden = true;
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(1));
    await untilQueued(app, 1);
    wakeLog.isHidden = false;
    wake();
    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(1);
    });
    await finishAll(call, clock);
    expect(await call).toFinishWith(ClaimRoomBatchWorkflowFinish, { text: "item-0" });
  });
});
