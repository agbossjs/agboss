/**
 * #1366 (shard `fence-workers`): the claims of one instance's queued-child workers on their own — a claimed child
 * runs only under the lease of its own thread (a take refused puts the claim back), stops when its tree is
 * cancelled, releases its lease at the end — retired when it answered or failed —, a running child is reclaimed only
 * by a live worker once its lease is free, and a stop waits for the children at work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { startChildWorkers, type ChildWorkers } from "../../src/app/remote/child-workers.js";
import { remoteChildSignals } from "../../src/flow/runtime/remote/remote-child-signals.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import type { QueuedChildExecution } from "../../src/infrastructure/child-execution-queue.repository.js";
import { SWEEP_EVERY } from "../../src/infrastructure/recovery.js";
import { treeKeyOf } from "../../src/infrastructure/in-memory-database.js";

const mocks = vi.hoisted(() => ({
  completedChild: vi.fn(),
  announcePass: vi.fn(),
  watchRunningChild: vi.fn(),
  childTakeOf: vi.fn(),
  isSameRunningClaim: vi.fn(),
  requeueIfStillClaimed: vi.fn(),
  watchOpen: vi.fn(),
  watchClose: vi.fn(),
}));
vi.mock("../../src/app/remote/child-completion.js", () => ({
  completedChild: mocks.completedChild,
}));
vi.mock("../../src/app/remote/child-end-event.js", () => ({ announcePass: mocks.announcePass }));
vi.mock("../../src/app/remote/child-registry.js", () => ({
  watchRunningChild: mocks.watchRunningChild,
  childTakeOf: mocks.childTakeOf,
  isSameRunningClaim: mocks.isSameRunningClaim,
}));
vi.mock("../../src/app/remote/look-pacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/remote/look-pacing.js")>()),
  requeueIfStillClaimed: mocks.requeueIfStillClaimed,
}));
vi.mock("../../src/app/remote/child-queue-watch.js", () => ({
  ChildQueueWatch: class {
    open = mocks.watchOpen;
    close = mocks.watchClose;
  },
}));

const row = (id: string, overrides: Partial<QueuedChildExecution> = {}): QueuedChildExecution => ({
  tenantId: "acme",
  executionId: id,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "root",
  workflow: "child",
  depth: 2,
  status: ExecutionRecordStatus.Running,
  run: "{}",
  queuedAt: new Date(0),
  ...overrides,
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) await turn();
  expect(condition()).toBe(true);
};

/** A clock whose sweep sleep is held until the test lets it go. */
function clockOf() {
  const sleeps: { delay: number; release: () => void }[] = [];
  return {
    sleeps,
    clock: {
      now: () => new Date("2026-01-05T09:00:00.000Z"),
      sleep: (delay: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          sleeps.push({ delay, release: resolve });
          signal?.addEventListener("abort", () => {
            resolve();
          });
        }),
    },
  };
}

function lease() {
  let cancelled: (() => void) | undefined;
  const controller = new AbortController();
  return {
    signal: controller.signal,
    release: vi.fn(() => Promise.resolve()),
    whenCancelFound: vi.fn((found: () => void) => {
      cancelled = found;
    }),
    foundCancel: () => cancelled?.(),
    lose: () => {
      controller.abort(new Error("the lease was lost"));
    },
  };
}

interface Setup {
  readonly rows: QueuedChildExecution[];
  readonly queue: {
    claimFirstByStatusQueuedOrderByDepthDesc: ReturnType<typeof vi.fn>;
    findByTenantIdAndExecutionId: ReturnType<typeof vi.fn>;
    saveIfAbsent: ReturnType<typeof vi.fn>;
  };
  readonly leases: { tryHold: ReturnType<typeof vi.fn> };
  readonly log: { warn: ReturnType<typeof vi.fn> };
  readonly interruption: AbortController;
}

const started: ChildWorkers[] = [];

function setup(options: { capacity?: unknown; held?: unknown[] } = {}) {
  const rows: QueuedChildExecution[] = [];
  const queue = {
    claimFirstByStatusQueuedOrderByDepthDesc: vi.fn(() => Promise.resolve(rows.shift())),
    findByTenantIdAndExecutionId: vi.fn(),
    saveIfAbsent: vi.fn(() => Promise.resolve(true)),
  };
  const held = options.held ?? [];
  const leases = { tryHold: vi.fn(() => Promise.resolve(held.shift())) };
  const log = { warn: vi.fn() };
  const interruption = new AbortController();
  const { clock, sleeps } = clockOf();
  const parts = {
    queue,
    leases,
    trees: {},
    clock,
    log,
    interruption: interruption.signal,
    capacity: options.capacity,
  };
  const start = (): ChildWorkers => {
    const workers = startChildWorkers(parts as never);
    started.push(workers);
    return workers;
  };
  return { rows, queue, leases, log, interruption, sleeps, start, held } satisfies Setup & {
    sleeps: unknown;
    start: unknown;
    held: unknown;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.watchOpen.mockResolvedValue(undefined);
  mocks.watchClose.mockResolvedValue(undefined);
  mocks.childTakeOf.mockImplementation(
    (_queue: unknown, claimed: QueuedChildExecution, isReclaim: boolean) => ({
      reason: "remote-child",
      isTakeover: isReclaim,
      claimed,
    }),
  );
  mocks.watchRunningChild.mockResolvedValue(undefined);
  mocks.announcePass.mockResolvedValue(undefined);
  mocks.requeueIfStillClaimed.mockResolvedValue(undefined);
  mocks.isSameRunningClaim.mockReturnValue(true);
  mocks.completedChild.mockResolvedValue({
    pass: { end: { status: ExecutionRecordStatus.Answered } },
    done: true,
  });
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((workers) => workers.stop()));
});

describe("#1366: the claims of a worker", () => {
  it("each sweep opens the queue's watch, looks, and sleeps SWEEP_EVERY on the clock before the next", async () => {
    const s = setup();
    s.start();

    await until(() => s.sleeps.length === 1);
    expect(mocks.watchOpen).toHaveBeenCalledOnce();
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledOnce();
    expect(s.sleeps[0]?.delay).toBe(SWEEP_EVERY);

    s.sleeps[0]?.release();
    await until(() => s.sleeps.length === 2);
    expect(mocks.watchOpen).toHaveBeenCalledTimes(2);
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledTimes(2);
  });

  it("a claimed child runs under the lease of its own thread: its tree, taken as the child's", async () => {
    const claimed = row("child-1");
    const held = lease();
    const s = setup({ held: [held] });
    s.rows.push(claimed);
    s.start();

    await until(() => s.leases.tryHold.mock.calls.length === 1);

    expect(s.leases.tryHold).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "child-1" },
      { reason: "remote-child", isTakeover: false, claimed },
    );
    expect(mocks.childTakeOf).toHaveBeenCalledWith(s.queue, claimed, false);
  });

  it("claims go on while the queue has children and the room is not used up, and stop at the first none", async () => {
    const s = setup({ held: [lease(), lease(), lease()] });
    s.rows.push(row("child-1"), row("child-2"), row("child-3"));
    s.start();

    await until(() => s.leases.tryHold.mock.calls.length === 3);
    await until(() => s.sleeps.length === 1);

    // three claimed and one look more that found the queue empty
    expect(
      s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("a child's lease and its end: the pass announced by the completion that won, the lease released retired when it answered", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);

    expect(mocks.completedChild).toHaveBeenCalledOnce();
    expect(mocks.completedChild.mock.calls[0]?.[1]).toMatchObject({ executionId: "child-1" });
    expect(mocks.completedChild.mock.calls[0]?.[2]).toBe(held);
    expect(mocks.announcePass).toHaveBeenCalledWith(
      s.queue,
      { end: { status: ExecutionRecordStatus.Answered } },
      true,
    );
    expect(held.release).toHaveBeenCalledWith({ isRetired: true });
  });

  it("a child that failed is retired too; one that paused is not (its lease stays takeable)", async () => {
    for (const [status, isRetired] of [
      [ExecutionRecordStatus.Failed, true],
      [ExecutionRecordStatus.Paused, false],
    ] as const) {
      const held = lease();
      const s = setup({ held: [held] });
      mocks.completedChild.mockResolvedValue({ pass: { end: { status } }, done: true });
      s.rows.push(row("child-1"));
      const workers = s.start();

      await until(() => held.release.mock.calls.length === 1);
      await workers.stop();

      expect(held.release).toHaveBeenCalledWith({ isRetired });
    }
  });

  it("a child that did not run (nothing to complete): no announcement, the lease released as not retired", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockResolvedValue(undefined);
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);

    expect(mocks.announcePass).not.toHaveBeenCalled();
    expect(held.release).toHaveBeenCalledWith({ isRetired: false });
    expect(s.log.warn).not.toHaveBeenCalled();
  });

  it("a completion another worker won, though this one's tree stood: logged, with the child's ids", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockResolvedValue({
      pass: { end: { status: ExecutionRecordStatus.Answered } },
      done: false,
    });
    s.rows.push(row("child-1"));
    s.start();

    await until(() => s.log.warn.mock.calls.length === 1);

    expect(s.log.warn).toHaveBeenCalledWith(
      "child-queue.not-completed",
      "child execution child-1 ended, but its tree no longer waits for it",
      { executionId: "child-1", tenantId: "acme" },
    );
  });

  it("no such log for a child stopped on purpose (its tree cancelled)", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockImplementation(async () => {
      held.foundCancel();
      return { pass: { end: { status: ExecutionRecordStatus.Failed } }, done: false };
    });
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);

    expect(s.log.warn).not.toHaveBeenCalled();
  });

  it("the child's signal ends with its lease, the instance's interruption, and the cancel its worker found; the watch is the child's own", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    let signal: AbortSignal | undefined;
    mocks.completedChild.mockImplementation(
      (_parts: unknown, _row: unknown, _lease: unknown, given: AbortSignal) => {
        signal = given;
        return new Promise((resolve) => {
          given.addEventListener("abort", () => {
            resolve(undefined);
          });
        });
      },
    );
    s.rows.push(row("child-1"));
    s.start();
    await until(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);

    held.foundCancel();

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(ExecutionCancelledError);
    expect((signal?.reason as Error).message).toBe("the child's tree was cancelled");
    expect(mocks.watchRunningChild).toHaveBeenCalledOnce();
    expect(mocks.watchRunningChild.mock.calls[0]?.[1]).toMatchObject({ executionId: "child-1" });
  });

  it.each(["lease", "interruption"])("the child's signal ends with its %s", async (which) => {
    const held = lease();
    const s = setup({ held: [held] });
    let signal: AbortSignal | undefined;
    mocks.completedChild.mockImplementation(
      (_parts: unknown, _row: unknown, _lease: unknown, given: AbortSignal) => {
        signal = given;
        return new Promise((resolve) => {
          given.addEventListener("abort", () => {
            resolve(undefined);
          });
        });
      },
    );
    s.rows.push(row("child-1"));
    s.start();
    await until(() => signal !== undefined);

    if (which === "lease") held.lose();
    else s.interruption.abort(new Error("stop"));

    expect(signal?.aborted).toBe(true);
  });

  it("a lease held elsewhere: the claim goes back to the queue, this worker's own look paced; nothing runs", async () => {
    const s = setup({ held: [undefined] });
    const claimed = row("child-1");
    s.rows.push(claimed);
    s.start();

    await until(() => mocks.requeueIfStillClaimed.mock.calls.length === 1);

    expect(mocks.requeueIfStillClaimed.mock.calls[0]?.[0]).toBe(s.queue);
    expect(mocks.requeueIfStillClaimed.mock.calls[0]?.[1]).toBe(claimed);
    expect(mocks.completedChild).not.toHaveBeenCalled();
  });

  it("a take that throws: the child's claim marker is lifted all the same", async () => {
    const s = setup();
    s.leases.tryHold.mockRejectedValue(new Error("the store is down"));
    const exit = vi.spyOn(remoteChildSignals, "enterClaim");
    s.rows.push(row("child-1"));
    s.start();

    await until(() => exit.mock.calls.length === 1);
    await until(() => !remoteChildSignals.isClaiming(treeKeyOf("acme", "child-1")));

    expect(mocks.completedChild).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("while the lease is being taken the child is marked claiming in this process, and no longer after", async () => {
    const s = setup();
    let seenClaiming: boolean | undefined;
    s.leases.tryHold.mockImplementation(() => {
      seenClaiming = remoteChildSignals.isClaiming(treeKeyOf("acme", "child-1"));
      return Promise.resolve(undefined);
    });
    s.rows.push(row("child-1"));
    s.start();

    await until(() => seenClaiming !== undefined);
    await until(() => mocks.requeueIfStillClaimed.mock.calls.length === 1);

    expect(seenClaiming).toBe(true);
    expect(remoteChildSignals.isClaiming(treeKeyOf("acme", "child-1"))).toBe(false);
  });

  it("a queue that cannot be read: a warning, no failure, the sweep goes on", async () => {
    const s = setup();
    s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mockRejectedValue(new Error("down"));
    s.start();

    await until(() => s.log.warn.mock.calls.length === 1);

    expect(s.log.warn).toHaveBeenCalledWith(
      "child-queue.failed",
      "the child queue could not be read: Error: down",
      {},
    );
    await until(() => s.sleeps.length === 1);
  });

  it("a child that ended is announced as ended in this process, and the claimed one's end wakes the next look", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    const ended = vi.spyOn(remoteChildSignals, "ended");
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);
    await until(() => s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length >= 3);

    expect(ended).toHaveBeenCalledWith(treeKeyOf("acme", "child-1"));
    expect(
      ended.mock.calls.filter(([key]) => key === treeKeyOf("acme", "child-1")).length,
    ).toBeGreaterThanOrEqual(2);
    ended.mockRestore();
  });

  it("a child that failed to run wakes no look of its own", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockRejectedValue(new Error("the child's run failed"));
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);
    await until(() => s.sleeps.length === 1);
    await turn();

    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledTimes(1 + 1);
  });

  it("a child queued in this process wakes the claim at once, not at the sweep", async () => {
    const s = setup();
    s.start();
    await until(() => s.sleeps.length === 1);
    const before = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;

    remoteChildSignals.queued();

    await until(() => s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length > before);
  });

  it("with no free step slot nothing is claimed; a child at work counts once by its slot or its claim", async () => {
    const free = { value: 0 };
    const capacity = { freeSlots: () => free.value, holdsSlot: () => false };
    const s = setup({ capacity, held: [lease()] });
    s.rows.push(row("child-1"));
    s.start();

    await until(() => s.sleeps.length === 1);
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).not.toHaveBeenCalled();

    free.value = 1;
    s.sleeps[0]?.release();
    await until(() => s.leases.tryHold.mock.calls.length === 1);
  });
});

describe("#1366: a running child's reclaim", () => {
  const running = row("child-1", { claimedAt: new Date(1) });

  it("the child its claimer left running, its lease free: taken over as a reclaim, put back in the queue, and run under the lease taken", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.rows.length = 0;
    s.start();
    await until(() => s.sleeps.length === 1);
    s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mockResolvedValueOnce(running);

    remoteChildSignals.running(running);

    await until(() => held.release.mock.calls.length === 1);
    await turn();
    await turn();
    await turn();
    // the child ran under the lease taken, and the lease went back once — by its own end, not again after the look
    expect(mocks.completedChild).toHaveBeenCalledOnce();
    expect(mocks.completedChild.mock.calls[0]?.[2]).toBe(held);
    expect(held.release).toHaveBeenCalledOnce();
    expect(s.leases.tryHold).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "child-1" },
      expect.objectContaining({ isTakeover: true }),
    );
    expect(mocks.childTakeOf).toHaveBeenCalledWith(s.queue, running, true);
    expect(s.queue.saveIfAbsent).toHaveBeenCalledWith({
      ...running,
      status: ExecutionRecordStatus.Queued,
      queuedAt: new Date("2026-01-05T09:00:00.000Z"),
    });
  });

  it("a row that is no longer the claim seen (ended, claimed again, gone): no lease asked for", async () => {
    const s = setup({ held: [lease()] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(undefined);
    mocks.isSameRunningClaim.mockReturnValue(false);
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    await turn();
    await turn();

    expect(mocks.isSameRunningClaim).toHaveBeenCalledWith(undefined, running);
    expect(s.leases.tryHold).not.toHaveBeenCalled();
  });

  it("a read of the row that fails is no claim: nothing is taken", async () => {
    const s = setup({ held: [lease()] });
    s.queue.findByTenantIdAndExecutionId.mockRejectedValue(new Error("down"));
    mocks.isSameRunningClaim.mockImplementation((current: unknown) => current !== undefined);
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    await until(() => mocks.isSameRunningClaim.mock.calls.length === 1);

    expect(mocks.isSameRunningClaim).toHaveBeenCalledWith(undefined, running);
    expect(s.leases.tryHold).not.toHaveBeenCalled();
  });

  it("a lease that is not free: nothing is requeued", async () => {
    const s = setup({ held: [undefined] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    await until(() => s.leases.tryHold.mock.calls.length === 1);
    await turn();

    expect(s.queue.saveIfAbsent).not.toHaveBeenCalled();
  });

  it("the claim moved on since the take: the lease goes back, never held unused", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.queue.saveIfAbsent.mockResolvedValue(false);
    s.start();
    await until(() => s.sleeps.length === 1);
    const claimsBefore = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;

    remoteChildSignals.running(running);

    await until(() => held.release.mock.calls.length === 1);
    expect(held.release).toHaveBeenCalledWith();
    expect(mocks.completedChild).not.toHaveBeenCalled();
    // given back at once: no look is made for a claim that is gone
    await turn();
    await turn();
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledTimes(claimsBefore);
  });

  it("a lease kept for a look that did not start the child is given back after the look", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    // the look finds nothing to claim: the pre-held lease is released
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);

    await until(() => held.release.mock.calls.length === 1);
    expect(held.release).toHaveBeenCalledWith();
    expect(mocks.completedChild).not.toHaveBeenCalled();
  });

  it("a worker that is stopping, or has no room, or already runs or reclaims the child, or whose claimer still acquires its lease, reclaims nothing", async () => {
    const s = setup({ held: [lease()] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.start();
    await until(() => s.sleeps.length === 1);

    const exit = remoteChildSignals.enterClaim(treeKeyOf("acme", "child-1"));
    remoteChildSignals.running(running);
    await turn();
    await turn();
    exit();

    expect(s.queue.findByTenantIdAndExecutionId).not.toHaveBeenCalled();
  });

  it("a stopped worker reclaims nothing", async () => {
    const s = setup({ held: [lease()] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    const workers = s.start();
    await until(() => s.sleeps.length === 1);
    await workers.stop();

    remoteChildSignals.running(running);
    await turn();

    expect(s.queue.findByTenantIdAndExecutionId).not.toHaveBeenCalled();
  });

  it("no room, no reclaim", async () => {
    const capacity = { freeSlots: () => 0, holdsSlot: () => false };
    const s = setup({ capacity, held: [lease()] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    await turn();
    await turn();

    expect(s.queue.findByTenantIdAndExecutionId).not.toHaveBeenCalled();
  });
});

describe("#1366: the stop of the workers", () => {
  it("a stop ends the sweep, closes the watch, stops hearing the queue, and waits for the children at work", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    let finish: () => void = () => undefined;
    mocks.completedChild.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(undefined);
          };
        }),
    );
    s.rows.push(row("child-1"));
    const workers = s.start();
    await until(() => s.leases.tryHold.mock.calls.length === 1 && s.sleeps.length >= 1);

    let stopped = false;
    const stopping = workers.stop().then(() => {
      stopped = true;
    });
    await turn();
    await turn();
    expect(mocks.watchClose).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(held.release).toHaveBeenCalledOnce();

    const before = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;
    remoteChildSignals.queued();
    await turn();
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length).toBe(before);
  });

  it("a stopped worker looks no more", async () => {
    const s = setup();
    const workers = s.start();
    await until(() => s.sleeps.length === 1);
    await workers.stop();
    const before = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;

    s.sleeps[0]?.release();
    await turn();

    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length).toBe(before);
  });
});

describe("#1366: the pace of the looks, and what a worker leaves behind", () => {
  const REFUSED_BACKOFF = 1000;

  it("the queue's and the reclaimers' hints are listened to until the worker stops, and no longer", async () => {
    const stops = { queued: vi.fn(), running: vi.fn() };
    const queued = vi.spyOn(remoteChildSignals, "onQueued");
    const running = vi.spyOn(remoteChildSignals, "onRunning");
    const heard = {
      queued: [] as (() => void)[],
      running: [] as ((row: QueuedChildExecution) => void)[],
    };
    queued.mockImplementation((claim: () => void) => {
      heard.queued.push(claim);
      return stops.queued;
    });
    running.mockImplementation((reclaim: (row: QueuedChildExecution) => void) => {
      heard.running.push(reclaim);
      return stops.running;
    });
    const s = setup();
    const workers = s.start();
    await until(() => s.sleeps.length === 1);
    expect(stops.queued).not.toHaveBeenCalled();
    expect(stops.running).not.toHaveBeenCalled();

    await workers.stop();

    expect(heard.queued).toHaveLength(1);
    expect(heard.running).toHaveLength(1);
    expect(stops.queued).toHaveBeenCalledOnce();
    expect(stops.running).toHaveBeenCalledOnce();
    queued.mockRestore();
    running.mockRestore();
  });

  it("a wake-up within the backoff of a refused take is held, never dropped: the look is made when the backoff has passed", async () => {
    const s = setup({ held: [undefined, lease()] });
    s.rows.push(row("child-1"));
    s.start();
    await until(() => mocks.requeueIfStillClaimed.mock.calls.length === 1);
    await until(() => s.sleeps.some((one) => one.delay === REFUSED_BACKOFF));
    const looks = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;

    s.rows.push(row("child-2"));
    remoteChildSignals.queued();
    await turn();
    await turn();
    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledTimes(looks);

    s.sleeps.find((one) => one.delay === REFUSED_BACKOFF)?.release();

    await until(() => s.leases.tryHold.mock.calls.length === 2);
    expect(s.leases.tryHold.mock.calls[1]?.[0]).toEqual({
      tenantId: "acme",
      rootExecutionId: "child-2",
    });
  });

  it("a refused take wakes no look of its own: after the backoff the queue is not looked at again until the sweep", async () => {
    const s = setup({ held: [undefined] });
    s.rows.push(row("child-1"));
    s.start();
    await until(() => mocks.requeueIfStillClaimed.mock.calls.length === 1);
    await until(() => s.sleeps.some((one) => one.delay === REFUSED_BACKOFF));
    await until(() => s.sleeps.some((one) => one.delay === SWEEP_EVERY));
    const looks = s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length;

    s.sleeps.find((one) => one.delay === REFUSED_BACKOFF)?.release();
    await turn();
    await turn();
    await turn();

    expect(s.queue.claimFirstByStatusQueuedOrderByDepthDesc).toHaveBeenCalledTimes(looks);
  });

  it("a child whose run failed is no longer at work here: its end is told, its room is back", async () => {
    const held = lease();
    const capacity = { used: 0, freeSlots: () => 1, holdsSlot: () => false };
    const s = setup({ capacity, held: [held, lease()] });
    const ended = vi.spyOn(remoteChildSignals, "ended");
    mocks.completedChild.mockRejectedValueOnce(new Error("the child's run failed"));
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);
    await until(() => ended.mock.calls.some(([key]) => key === treeKeyOf("acme", "child-1")));
    // the room is free again for the next child
    s.rows.push(row("child-2"));
    remoteChildSignals.queued();
    await until(() => s.leases.tryHold.mock.calls.length === 2);

    expect(ended).toHaveBeenCalledWith(treeKeyOf("acme", "child-1"));
    ended.mockRestore();
  });

  it("a child that had nothing to run ended well: the next look is made", async () => {
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockResolvedValue(undefined);
    s.rows.push(row("child-1"));
    s.start();

    await until(() => held.release.mock.calls.length === 1);
    await until(() => s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mock.calls.length >= 3);

    expect(held.release).toHaveBeenCalledWith({ isRetired: false });
  });

  it("a child that works here is not reclaimed; one being reclaimed is not reclaimed twice", async () => {
    const running = row("child-1", { claimedAt: new Date(1) });
    const held = lease();
    const s = setup({ held: [held] });
    mocks.completedChild.mockImplementation(
      (_parts: unknown, _row: unknown, _lease: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve(undefined);
          });
        }),
    );
    s.rows.push(row("child-1"));
    s.start();
    await until(() => mocks.completedChild.mock.calls.length === 1);
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);

    remoteChildSignals.running(running);
    await turn();
    await turn();
    expect(s.queue.findByTenantIdAndExecutionId).not.toHaveBeenCalled();
    held.lose();
  });

  it("a reclaim under way blocks a second one of the same child", async () => {
    const running = row("child-9", { claimedAt: new Date(1) });
    const s = setup({ held: [lease()] });
    let answer: (value: QueuedChildExecution) => void = () => undefined;
    s.queue.findByTenantIdAndExecutionId.mockImplementation(
      () =>
        new Promise<QueuedChildExecution>((resolve) => {
          answer = resolve;
        }),
    );
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    remoteChildSignals.running(running);
    await turn();
    await turn();

    expect(s.queue.findByTenantIdAndExecutionId).toHaveBeenCalledOnce();
    mocks.isSameRunningClaim.mockReturnValue(false);
    answer(running);
  });

  it("a reclaim's look is made at once, whatever the backoff of a refused take: the lease it holds is used by that look", async () => {
    const running = row("child-1", { claimedAt: new Date(1) });
    const reclaimed = lease();
    const s = setup({ held: [undefined, reclaimed] });
    s.rows.push(row("child-0"));
    s.start();
    await until(() => mocks.requeueIfStillClaimed.mock.calls.length === 1);
    await until(() => s.sleeps.some((one) => one.delay === REFUSED_BACKOFF));
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.queue.claimFirstByStatusQueuedOrderByDepthDesc.mockResolvedValueOnce(running);

    remoteChildSignals.running(running);

    await until(() => mocks.completedChild.mock.calls.length === 1);
    expect(mocks.completedChild.mock.calls[0]?.[2]).toBe(reclaimed);
  });

  it("a lease given back after a look that did not start the child is forgotten: the child's next claim takes a lease of its own", async () => {
    const running = row("child-1", { claimedAt: new Date(1) });
    const given = lease();
    const fresh = lease();
    const s = setup({ held: [given, fresh] });
    s.queue.findByTenantIdAndExecutionId.mockResolvedValue(running);
    s.start();
    await until(() => s.sleeps.length === 1);

    remoteChildSignals.running(running);
    await until(() => given.release.mock.calls.length === 1);
    s.rows.push(row("child-1"));
    remoteChildSignals.queued();

    await until(() => mocks.completedChild.mock.calls.length === 1);
    expect(mocks.completedChild.mock.calls[0]?.[2]).toBe(fresh);
    expect(s.leases.tryHold).toHaveBeenCalledTimes(2);
  });
});
