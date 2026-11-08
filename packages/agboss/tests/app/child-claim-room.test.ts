/**
 * #767 — a worker's room to claim children on any instance counts each claimed child once: a child
 * at work holds a step slot and is not counted again as a claim (AC1). An instance of three slots
 * keeps three children at work while the queue has more (its free-slot gauge reads 0, AC2), and
 * never more than its slots — a step of a root holding one leaves room for two children only.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ChildExecutionQueueRepository } from "../../src/index.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { collect, instanceMeter, valueOf } from "../metrics/support/metric-reader.js";
import { untilSettled } from "../metrics/support/runs.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  ClaimRoomApplication,
  ClaimRoomBatchWorkflowFinish,
  ClaimRoomBatchWorkflowStart,
  ClaimRoomItemWorkflowStart,
  releaseItem,
  resetRoomLog,
  roomItemsOf,
  roomLog,
} from "./fixtures/claim-room.workflow.js";

const meter = instanceMeter();
const test = testWith(ClaimRoomApplication, {
  concurrency: TestConcurrency.Real,
  instances: [{ meterProvider: meter.provider }],
});

beforeEach(resetRoomLog);
afterEach(resetRoomLog);

/** The instance's slot gauges now. */
async function slotsNow(): Promise<{ busy: number | undefined; free: number | undefined }> {
  const collected = await collect(meter);
  return {
    busy: valueOf(collected, "agboss.instance.step_slots.busy"),
    free: valueOf(collected, "agboss.instance.step_slots.free"),
  };
}

/** The queue's rows now: claimed (`Running`) and still `Queued` — a worker never holds more than its slots. */
async function rowsNow(app: TestApp): Promise<{ running: number; queued: number }> {
  const { running, queued } = await app.resolve(ChildExecutionQueueRepository).countByStatus();
  return { running, queued };
}

/** The first item whose step waits at its gate now. */
function anyAtWork(): string {
  const [item] = [...roomLog.gates.keys()];
  if (item === undefined) throw new Error("no step waits at its gate");
  return item;
}

describe("#767 AC1/AC2: a worker with N free slots keeps N children at work", () => {
  test("eight children, three slots: each child that ends is replaced at once, never a fourth", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(8));
    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(3);
    });
    expect(await slotsNow()).toEqual({ busy: 3, free: 0 });
    // never claims beyond its slots: the other five stay in the queue for any instance
    expect(await rowsNow(app)).toEqual({ running: 3, queued: 5 });

    // five more in the queue: every end frees a slot that the next child takes
    for (let ended = 1; ended <= 5; ended += 1) {
      releaseItem(anyAtWork());
      await vi.waitFor(async () => {
        expect(roomLog.atWork.size).toBe(3);
        expect(roomLog.gates.size).toBe(3);
        expect(await rowsNow(app)).toEqual({ running: 3, queued: 5 - ended });
      });
      expect(await slotsNow()).toEqual({ busy: 3, free: 0 });
    }
    // the queue is empty: the last three end in turn
    for (let left = 3; left > 0; left -= 1) {
      releaseItem(anyAtWork());
      await vi.waitFor(() => {
        expect(roomLog.gates.size).toBe(left - 1);
      });
    }
    await untilSettled(call, clock);

    expect(await call).toFinishWith(ClaimRoomBatchWorkflowFinish, {
      text: roomItemsOf(8)
        .map((item) => item.name)
        .join(", "),
    });
    expect(roomLog.most).toBe(3);
  });

  test("a root's step holds a slot: the worker claims the two free ones, a third once it ends", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const root = execute(app, ClaimRoomItemWorkflowStart, {
      name: "root",
      delay: 0,
      outcome: "ok",
    });
    await vi.waitFor(() => {
      expect(roomLog.gates.has("root")).toBe(true);
    });
    const call = execute(app, ClaimRoomBatchWorkflowStart, roomItemsOf(4));
    await vi.waitFor(() => {
      expect(roomLog.atWork.size).toBe(3);
    });
    // a sweep looks again: still no room for a third child
    for (let tick = 0; tick < 3; tick += 1) await clock.advance(seconds(10));
    await settle();
    expect(roomLog.atWork.size).toBe(3);
    expect(roomLog.most).toBe(3);
    expect(await slotsNow()).toEqual({ busy: 3, free: 0 });

    releaseItem("root");
    await root;
    // the next sweep (or a child's end) claims into the freed slot
    await vi.waitFor(async () => {
      await clock.advance(seconds(10));
      expect(roomLog.atWork.size).toBe(3);
      expect(roomLog.atWork.has("root")).toBe(false);
    });

    const done = untilSettled(call, clock, () => {
      for (const item of [...roomLog.gates.keys()]) releaseItem(item);
      return Promise.resolve();
    });
    await done;
    expect(await call).toFinishWith(ClaimRoomBatchWorkflowFinish, {
      text: "item-0, item-1, item-2, item-3",
    });
    expect(roomLog.most).toBe(3);
  });
});
