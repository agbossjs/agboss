/**
 * #1356 (mutation shard `fencing`): the marks on a tree's lease row — an operator's pause with its reason, mode and
 * fence, the stop with its mode that only escalates, the cancel, what the row reports of them all in one read and the
 * history row each change writes (once, only when it changed something, at the store's time) — each rule asked of
 * the in-memory lease store and of the SQLite one alike, through their public methods.
 */
import { describe, expect, it } from "vitest";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { inMemoryInterruptedOf, markOf } from "../../src/infrastructure/in-memory-cancel-mark.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { sqliteInterruptedOf, stopModeOf } from "../../src/infrastructure/sqlite/sqlite-stop.js";
import {
  memoryStatusLog,
  sqliteStatusLog,
  StatusTrigger,
  ThreadStatus,
  type NewStatusTransition,
  type ThreadStatusTransition,
} from "../../src/turns/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const TREE = { tenantId: "default", rootExecutionId: "root-1" };
const THREAD = { tenantId: "default", threadId: "thread-1" };
const contextOf = () =>
  applicationContextOf({
    name: "marks-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: new Date(0),
    profiles: ["test"],
  });

interface Store {
  readonly clock: VirtualClock;
  readonly leases: ExecutionLeaseRepository;
  readonly history: () => readonly ThreadStatusTransition[];
  readonly isInterrupted: () => boolean;
}

function inMemory(): Store {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), contextOf(), database);
  return {
    clock,
    leases,
    history: () => memoryStatusLog(database.statusTransitions).historyOf(THREAD),
    isInterrupted: () => inMemoryInterruptedOf(database)(TREE),
  };
}

function sqlite(): Store {
  const clock = new VirtualClock();
  const connection = connectionTo(temporarySqlitePath());
  const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), contextOf());
  return {
    clock,
    leases,
    history: () => sqliteStatusLog(connection.database).historyOf(THREAD),
    isInterrupted: () => sqliteInterruptedOf(connection.database)(TREE),
  };
}

const change = (
  toStatus: ThreadStatus,
  trigger: StatusTrigger,
  more: Partial<NewStatusTransition> = {},
): NewStatusTransition => ({ ...THREAD, toStatus, trigger, ...more });

describe.each([
  ["in-memory", inMemory],
  ["SQLite", sqlite],
])("#1341b, #1341c: the marks on a tree's lease row (%s)", (_kind, make) => {
  it("a tree with no row has no pause, no stop and no mark, and is not interrupted", async () => {
    const { leases, isInterrupted } = make();

    expect(await leases.pauseOf(TREE)).toStrictEqual({});
    expect(await leases.stopOf(TREE)).toBeUndefined();
    expect(await leases.markedOf(TREE)).toStrictEqual({ isCancelRequested: false });
    expect(isInterrupted()).toBe(false);
  });

  it("a pause keeps its reason and its mode; one with no reason has none; an AfterStep one fences nothing", async () => {
    const { leases } = make();

    await leases.requestPause(TREE, { mode: InterruptMode.AfterStep, reason: "maintenance" });
    expect(await leases.pauseOf(TREE)).toStrictEqual({
      pause: { reason: "maintenance", mode: InterruptMode.AfterStep },
    });

    await leases.unpause(TREE);
    await leases.requestPause(TREE, { mode: InterruptMode.AfterStep });
    expect(await leases.pauseOf(TREE)).toStrictEqual({ pause: { mode: InterruptMode.AfterStep } });
  });

  it("an Immediate pause fences the row's token (0 of a tree never held) and unpause keeps the fence", async () => {
    const { leases } = make();

    await leases.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "now" });
    expect(await leases.pauseOf(TREE)).toStrictEqual({
      pause: { reason: "now", mode: InterruptMode.Immediate },
      fencedThroughToken: 0,
    });
    await leases.unpause(TREE);

    expect(await leases.pauseOf(TREE)).toStrictEqual({ fencedThroughToken: 0 });
  });

  it("an Immediate pause of a held tree fences the lease's token; a later one never lowers it", async () => {
    const { leases } = make();
    const held = await leases.acquire("default", "root-1", hours(1));
    expect(held?.token).toBe(1);

    await leases.requestPause(TREE, { mode: InterruptMode.Immediate });

    expect(await leases.pauseOf(TREE)).toMatchObject({ fencedThroughToken: 1 });
    await leases.unpause(TREE);
    await leases.requestPause(TREE, { mode: InterruptMode.AfterStep });
    expect(await leases.pauseOf(TREE)).toStrictEqual({
      pause: { mode: InterruptMode.AfterStep },
      fencedThroughToken: 1,
    });
  });

  it("a pause writes its history row once, at the store's time; a repeat of a pause in force writes none", async () => {
    const { leases, history, clock } = make();
    await clock.advance(seconds(5));
    const at = clock.now();

    await leases.requestPause(
      TREE,
      { mode: InterruptMode.AfterStep },
      change(ThreadStatus.Pausing, StatusTrigger.Pause, { actor: "operator-1" }),
    );
    await clock.advance(seconds(5));
    await leases.requestPause(
      TREE,
      { mode: InterruptMode.Immediate },
      change(ThreadStatus.ExternallyPaused, StatusTrigger.Pause),
    );

    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      toStatus: ThreadStatus.Pausing,
      trigger: StatusTrigger.Pause,
      actor: "operator-1",
      at,
    });
  });

  it("unpause writes its history row when it lifted a pause, at the store's time, and none when nothing was paused", async () => {
    const { leases, history, clock } = make();
    const unpaused = change(ThreadStatus.Running, StatusTrigger.Unpause);
    await leases.unpause(TREE, unpaused);
    expect(history()).toStrictEqual([]);

    await leases.requestPause(TREE, { mode: InterruptMode.AfterStep });
    await clock.advance(seconds(9));
    const at = clock.now();
    await leases.unpause(TREE, unpaused);
    await leases.unpause(TREE, change(ThreadStatus.Paused, StatusTrigger.Unpause));

    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      toStatus: ThreadStatus.Running,
      trigger: StatusTrigger.Unpause,
      at,
    });
  });

  it("a stop is marked once and its mode only escalates: AfterStep to Immediate, never back", async () => {
    const { leases } = make();

    await leases.requestStop(TREE, InterruptMode.AfterStep);
    expect(await leases.stopOf(TREE)).toStrictEqual({ mode: InterruptMode.AfterStep });
    await leases.requestStop(TREE, InterruptMode.AfterStep);
    expect(await leases.stopOf(TREE)).toStrictEqual({ mode: InterruptMode.AfterStep });
    await leases.requestStop(TREE, InterruptMode.Immediate);
    expect(await leases.stopOf(TREE)).toStrictEqual({ mode: InterruptMode.Immediate });
    await leases.requestStop(TREE, InterruptMode.AfterStep);
    expect(await leases.stopOf(TREE)).toStrictEqual({ mode: InterruptMode.Immediate });
    await leases.requestStop(TREE, InterruptMode.Immediate);
    expect(await leases.stopOf(TREE)).toStrictEqual({ mode: InterruptMode.Immediate });
  });

  it("a stop writes its history row only when it set or escalated the mark, at the store's time", async () => {
    const { leases, history, clock } = make();
    const statuses = [
      ThreadStatus.Stopping,
      ThreadStatus.Stopped,
      ThreadStatus.Cancelling,
      ThreadStatus.Cancelled,
    ];
    let next = 0;
    const stop = async (mode: InterruptMode) => {
      await leases.requestStop(
        TREE,
        mode,
        change(statuses[next] ?? ThreadStatus.Failed, StatusTrigger.Stop),
      );
      next += 1;
    };

    await clock.advance(seconds(3));
    const first = clock.now();
    await stop(InterruptMode.AfterStep);
    await stop(InterruptMode.AfterStep);
    await clock.advance(seconds(3));
    const escalated = clock.now();
    await stop(InterruptMode.Immediate);
    await stop(InterruptMode.AfterStep);
    await stop(InterruptMode.Immediate);

    expect(history().map((row) => [row.toStatus, row.at])).toStrictEqual([
      [ThreadStatus.Stopping, first],
      [ThreadStatus.Cancelling, escalated],
    ]);
  });

  it("what the row reports of its marks in one read: the cancel, the stop with its mode, the pause and its fence", async () => {
    const { leases } = make();
    expect(await leases.markedOf(TREE)).toStrictEqual({ isCancelRequested: false });

    await leases.requestStop(TREE, InterruptMode.AfterStep);
    expect(await leases.markedOf(TREE)).toStrictEqual({
      isCancelRequested: false,
      stop: { mode: InterruptMode.AfterStep },
    });
    await leases.requestCancel(TREE);
    await leases.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "hold" });

    expect(await leases.markedOf(TREE)).toStrictEqual({
      isCancelRequested: true,
      stop: { mode: InterruptMode.AfterStep },
      pause: { reason: "hold", mode: InterruptMode.Immediate },
      fencedThroughToken: 0,
    });
  });

  it("a tree is interrupted by a stop or by a cancel, not by a pause", async () => {
    const stopped = make();
    const cancelled = make();
    const paused = make();

    await stopped.leases.requestStop(TREE, InterruptMode.AfterStep);
    await cancelled.leases.requestCancel(TREE);
    await paused.leases.requestPause(TREE, { mode: InterruptMode.Immediate });

    expect(stopped.isInterrupted()).toBe(true);
    expect(cancelled.isInterrupted()).toBe(true);
    expect(paused.isInterrupted()).toBe(false);
  });

  it("a cancel writes its history row once, at the store's time", async () => {
    const { leases, history, clock } = make();
    await clock.advance(seconds(2));
    const at = clock.now();

    await leases.requestCancel(TREE, change(ThreadStatus.Cancelling, StatusTrigger.Cancel));
    await leases.requestCancel(TREE, change(ThreadStatus.Cancelled, StatusTrigger.Cancel));

    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({ toStatus: ThreadStatus.Cancelling, at });
  });
});

describe("#1341b: the stop's mode read straight from a SQLite row", () => {
  it("is none for a tree with no row, the stored mode otherwise", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const leases = new SqliteExecutionLeaseRepository(
      connection,
      storeClockOf(new VirtualClock()),
      contextOf(),
    );
    expect(stopModeOf(connection.database, TREE)).toBeUndefined();

    await leases.requestStop(TREE, InterruptMode.Immediate);

    expect(stopModeOf(connection.database, TREE)).toBe(InterruptMode.Immediate);
  });
});

describe("#1341c: the marks a rewritten row keeps", () => {
  const row = (changes: Record<string, unknown>) =>
    ({ lease: { token: 3 }, released: false, ...changes }) as never;

  it("a row with no mark keeps none, and a row that does not exist keeps none either", () => {
    expect(markOf(undefined)).toStrictEqual({});
    expect(markOf(undefined, 7)).toStrictEqual({});
    expect(markOf(row({}), 7)).toStrictEqual({});
  });

  it("the cancel, the stop mode, the pause and the fence are kept as they were", () => {
    const pause = { mode: InterruptMode.AfterStep, reason: "hold" };

    expect(
      markOf(
        row({
          cancelRequestedAt: 0,
          stopMode: InterruptMode.Immediate,
          externalPause: pause,
          fencedThroughToken: 2,
        }),
      ),
    ).toStrictEqual({
      cancelRequestedAt: 0,
      stopMode: InterruptMode.Immediate,
      externalPause: pause,
      fencedThroughToken: 2,
    });
  });

  it("a reclaim under an Immediate pause raises the fence to the reclaimed token, never lowers it; under any other, it is as it was", () => {
    const immediate = { mode: InterruptMode.Immediate };
    const afterStep = { mode: InterruptMode.AfterStep };

    expect(markOf(row({ externalPause: immediate }), 7)).toMatchObject({ fencedThroughToken: 7 });
    expect(markOf(row({ externalPause: immediate, fencedThroughToken: 4 }), 7)).toMatchObject({
      fencedThroughToken: 7,
    });
    expect(markOf(row({ externalPause: immediate, fencedThroughToken: 9 }), 7)).toMatchObject({
      fencedThroughToken: 9,
    });
    expect(markOf(row({ externalPause: immediate, fencedThroughToken: 4 }))).toMatchObject({
      fencedThroughToken: 4,
    });
    expect(markOf(row({ externalPause: afterStep, fencedThroughToken: 4 }), 7)).toMatchObject({
      fencedThroughToken: 4,
    });
    expect(markOf(row({ externalPause: afterStep }), 7)).toStrictEqual({
      externalPause: afterStep,
    });
  });
});
