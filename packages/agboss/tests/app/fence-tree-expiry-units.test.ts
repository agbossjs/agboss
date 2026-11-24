import { usd } from "../../src/units/index.js";
/**
 * #1366, #1065 (shard `fence-tree`): the part of moving a tree that an expiry adds (`tree-expiry.ts`), on its own —
 * the lease is taken only when free and given back whenever nothing is drained, the pass an expiry starts is
 * planned only for a resting tree with a pause due, the drain's failure is the run's own outcome when the
 * run ended or was handed over.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResumeReason } from "../../src/core/observability.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { endedByRun, expiredMove, expiredPassOf, restedPassOf } from "../../src/app/tree-expiry.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";

const mocks = vi.hoisted(() => ({
  duePausesOf: vi.fn(),
  expirePauses: vi.fn(),
  answeredPassOf: vi.fn(),
  recoveryPassOf: vi.fn(),
  forgetTree: vi.fn(),
}));
vi.mock("../../src/app/pause-expiry.js", () => ({
  duePausesOf: mocks.duePausesOf,
  expirePauses: mocks.expirePauses,
}));
vi.mock("../../src/app/recovery-pass.js", () => ({
  answeredPassOf: mocks.answeredPassOf,
  recoveryPassOf: mocks.recoveryPassOf,
}));
vi.mock("../../src/app/tree-ends.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/tree-ends.js")>()),
  forgetTree: mocks.forgetTree,
}));

const STATE = { runId: "root-1", threadId: "t-1", tenantId: "acme", startedVersion: "1" };
const NOW = new Date("2026-01-01T12:00:00.000Z");
const stored = {
  run: { runId: "root-1", turnId: "turn-1", path: ["a", "b"], cost: { totalUsd: usd(0.25) } },
};

function partsOf(options: { turns?: unknown[]; found?: unknown; lease?: unknown } = {}) {
  const completeIfStatus = vi.fn(() => Promise.resolve(true));
  const byIds = vi.fn((_ids: string[]) => Promise.resolve(options.turns ?? []));
  const lease = "lease" in options ? options.lease : { release: vi.fn(() => Promise.resolve()) };
  const tryHold = vi.fn((_tree: unknown, _take: unknown) => Promise.resolve(lease));
  const find = vi.fn(() => Promise.resolve("found" in options ? options.found : stored));
  const parts = {
    deps: { turns: { completeIfStatus, byIds }, pause: undefined },
    paused: { find },
    // not paused from outside (#1341c)
    leases: { tryHold, pauseOf: () => Promise.resolve({}) },
    clock: { now: () => NOW },
    trees: {},
  };
  return { parts: parts as never, completeIfStatus, byIds, tryHold, find, lease };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.duePausesOf.mockResolvedValue([]);
  mocks.expirePauses.mockResolvedValue(0);
  mocks.answeredPassOf.mockResolvedValue(undefined);
  mocks.recoveryPassOf.mockResolvedValue(undefined);
  mocks.forgetTree.mockResolvedValue(undefined);
});

const record = (status: ExecutionRecordStatus | string) => ({
  id: "turn-1",
  status,
  stopReason: "why",
  threadId: "t-1",
});

describe("#1366: the pass an expiry starts", () => {
  it("a tree that rests no more (no paused run, or another run's): nothing is looked for, marked or asked", async () => {
    for (const found of [undefined, { run: { ...stored.run, runId: "other" } }]) {
      const { parts, completeIfStatus } = partsOf({ found });
      mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);

      expect(await expiredPassOf(parts, STATE as never, {}, { tried: new Set() })).toBeUndefined();

      expect(completeIfStatus).not.toHaveBeenCalled();
      expect(mocks.expirePauses).not.toHaveBeenCalled();
    }
  });

  it("the due pauses are those of the tree at the clock's now, but never one this holder already tried", async () => {
    const { parts } = partsOf();
    const tried = new Set(["p-old"]);
    mocks.duePausesOf.mockResolvedValue([
      { pauseId: "p-old" },
      { pauseId: "p-1" },
      { pauseId: "p-2" },
    ]);
    mocks.answeredPassOf.mockResolvedValue({ pass: "answered" });

    const planned = await expiredPassOf(parts, STATE, { signal: undefined }, { tried });

    expect(mocks.duePausesOf).toHaveBeenCalledWith(parts, STATE, NOW);
    expect(mocks.expirePauses).toHaveBeenCalledWith(
      parts,
      [{ pauseId: "p-1" }, { pauseId: "p-2" }],
      undefined,
    );
    expect([...tried].sort()).toEqual(["p-1", "p-2", "p-old"]);
    expect(planned).toEqual({ pass: "answered" });
  });

  it("the root is marked running, from paused, with the run's path and cost, before anything is expired", async () => {
    const { parts, completeIfStatus } = partsOf();
    const order: string[] = [];
    completeIfStatus.mockImplementation(() => {
      order.push("mark");
      return Promise.resolve(true);
    });
    mocks.expirePauses.mockImplementation(() => {
      order.push("expire");
      return Promise.resolve(1);
    });
    mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);
    const signal = new AbortController().signal;

    await expiredPassOf(parts, STATE, { signal }, { tried: new Set() });

    expect(order).toEqual(["mark", "expire"]);
    expect(completeIfStatus).toHaveBeenCalledWith("turn-1", ExecutionRecordStatus.Paused, {
      replyWith: "",
      status: "running",
      stopReason: "",
      route: ["a", "b"],
      steps: [],
      costUsd: usd(0.25),
    });
    expect(mocks.expirePauses.mock.calls[0]?.[2]).toBe(signal);
  });

  it("the answers it takes: the passes of earlier ones are not taken again", async () => {
    const { parts } = partsOf();
    mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);
    const passed = new Set(["p-0"]);

    await expiredPassOf(parts, STATE, {}, { tried: new Set(), passed });

    expect(mocks.answeredPassOf).toHaveBeenCalledWith(parts, STATE, {}, passed);
  });

  it("nothing to take after the expiry: the tree is rested again for the turn the run is on", async () => {
    const { parts } = partsOf();
    mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);
    mocks.recoveryPassOf.mockResolvedValue({ pass: "rest" });

    expect(
      await expiredPassOf(parts, STATE as never, { signal: undefined }, { tried: new Set() }),
    ).toEqual({
      pass: "rest",
    });
    expect(mocks.recoveryPassOf).toHaveBeenCalledWith(
      parts,
      { ...STATE, turnId: "turn-1" },
      { signal: undefined },
    );
  });

  it("what a drain continues with at a rest: the answers first, else the expiry, else nothing", async () => {
    const { parts } = partsOf();
    const track = { passed: new Set<string>(), tried: new Set<string>() };

    mocks.answeredPassOf.mockResolvedValueOnce({ pass: "answered" });
    expect(await restedPassOf(parts, STATE as never, {}, track)).toEqual({
      planned: { pass: "answered" },
      reason: ResumeReason.Answered,
    });
    expect(mocks.answeredPassOf).toHaveBeenCalledWith(parts, STATE, {}, track.passed, true);
    expect(mocks.duePausesOf).not.toHaveBeenCalled();

    mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);
    mocks.recoveryPassOf.mockResolvedValue({ pass: "rest" });
    expect(await restedPassOf(parts, STATE as never, {}, track)).toEqual({
      planned: { pass: "rest" },
      reason: ResumeReason.Expired,
    });

    mocks.duePausesOf.mockResolvedValue([]);
    expect(await restedPassOf(parts, STATE as never, {}, track)).toBeUndefined();
  });
});

describe("#1366: whether the run ended by its own outcome", () => {
  it.each([
    [ExecutionRecordStatus.Answered, true],
    [ExecutionRecordStatus.Failed, true],
    [ExecutionRecordStatus.Guarded, true],
    [ExecutionRecordStatus.Paused, false],
    [ExecutionRecordStatus.Running, false],
  ])("a record %s: %s", async (status, ended) => {
    const { parts, byIds } = partsOf({ turns: [record(status)] });

    expect(await endedByRun(parts, "turn-1")).toBe(ended);
    expect(byIds).toHaveBeenCalledWith(["turn-1"]);
  });

  it("a record that is not found, or not read: no", async () => {
    expect(await endedByRun(partsOf({ turns: [] }).parts, "turn-1")).toBe(false);
    const { parts, byIds } = partsOf();
    byIds.mockRejectedValue(new Error("the store is down"));
    expect(await endedByRun(parts, "turn-1")).toBe(false);
  });

  it("a read that throws before it returns a promise (node:sqlite does): no end, the throw is answered here (#1375)", async () => {
    const { parts, byIds } = partsOf();
    byIds.mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });

    await expect(endedByRun(parts, "turn-1")).resolves.toBe(false);
  });

  it.each([
    ["a null record", [null]],
    ["no list of records", undefined],
  ])("a read that gives %s: no end, never a rejection (#1375)", async (_name, read) => {
    const { parts, byIds } = partsOf();
    byIds.mockResolvedValue(read as never);

    await expect(endedByRun(parts, "turn-1")).resolves.toBe(false);
  });
});

describe("#1366: the expiry look's move", () => {
  const interrupted = { ...STATE, turnId: "turn-1", extra: "dropped" } as never;
  const hooksOf = () => ({
    endedAtTake: vi.fn((_state: unknown, _lease: unknown) => Promise.resolve(undefined)),
    announce: vi.fn(() => Promise.resolve()),
    drained: vi.fn((_state: unknown, _lease: unknown, _first: unknown) => Promise.resolve("done")),
  });
  const due = () => {
    mocks.duePausesOf.mockResolvedValue([{ pauseId: "p-1" }]);
    mocks.answeredPassOf.mockResolvedValue({ pass: "answered", resume: { values: {} } });
  };

  it("a lease that is not free: nothing else is done", async () => {
    const { parts, tryHold } = partsOf({ lease: undefined });
    const hooks = hooksOf();

    await expiredMove(parts, hooks as never, interrupted, {});

    expect(tryHold).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      expect.objectContaining({ reason: LeaseTakeoverReason.Expired }),
    );
    expect(hooks.endedAtTake).not.toHaveBeenCalled();
  });

  it("the tree is held as `expired`, asked at the take with the state of the tree only", async () => {
    const { parts, lease } = partsOf({ turns: [record(ExecutionRecordStatus.Running)] });
    const hooks = hooksOf();

    await expiredMove(parts, hooks as never, interrupted, {});

    expect(hooks.endedAtTake).toHaveBeenCalledWith(STATE, lease);
  });

  it("a cancel or an undo at the take ends the tree: nothing is read, nothing released here", async () => {
    const { parts, lease, byIds } = partsOf();
    const hooks = hooksOf();
    hooks.endedAtTake.mockResolvedValue(new Error("cancelled") as never);
    const onTaken = vi.fn();

    await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

    expect(byIds).not.toHaveBeenCalled();
    expect(onTaken).not.toHaveBeenCalled();
    expect((lease as { release: () => void }).release).not.toHaveBeenCalled();
  });

  it("a root whose record runs: not this move's — the lease is released, nothing counted, planned or announced", async () => {
    const { parts, lease, byIds } = partsOf({ turns: [record(ExecutionRecordStatus.Running)] });
    const hooks = hooksOf();
    const onTaken = vi.fn();

    await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

    expect(onTaken).not.toHaveBeenCalled();
    expect(mocks.forgetTree).not.toHaveBeenCalled();
    expect(hooks.announce).not.toHaveBeenCalled();
    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
    expect(byIds).toHaveBeenCalledWith(["turn-1"]);
  });

  it("a root whose record is missing is not resting: released", async () => {
    const { parts, lease } = partsOf({ turns: [] });
    const hooks = hooksOf();
    const onTaken = vi.fn();

    await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

    expect(onTaken).not.toHaveBeenCalled();
    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
  });

  it.each([
    ExecutionRecordStatus.Answered,
    ExecutionRecordStatus.Failed,
    ExecutionRecordStatus.Guarded,
  ])(
    "a root whose record ended (%s): its tree's end is finished on the record's cause, nothing is planned, the lease released",
    async (status) => {
      const { parts, lease } = partsOf({ turns: [record(status)] });
      const hooks = hooksOf();
      const onTaken = vi.fn();

      await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

      expect(mocks.forgetTree).toHaveBeenCalledOnce();
      expect(mocks.forgetTree).toHaveBeenCalledWith(
        parts,
        STATE,
        expect.objectContaining({ message: "why" }),
      );
      expect(onTaken).not.toHaveBeenCalled();
      expect(mocks.duePausesOf).not.toHaveBeenCalled();
      expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
    },
  );

  it("a resting root with nothing due: counted as taken, nothing announced, the lease released", async () => {
    const { parts, lease } = partsOf({ turns: [record(ExecutionRecordStatus.Paused)] });
    const hooks = hooksOf();
    const onTaken = vi.fn();

    await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

    expect(onTaken).toHaveBeenCalledOnce();
    expect(hooks.announce).not.toHaveBeenCalled();
    expect(hooks.drained).not.toHaveBeenCalled();
    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
  });

  it("a resting root with a pause due: counted before the pass is planned, announced, then drained under the held lease — which the drain releases", async () => {
    const { parts, lease } = partsOf({ turns: [record(ExecutionRecordStatus.Paused)] });
    const hooks = hooksOf();
    const order: string[] = [];
    const onTaken = vi.fn(() => order.push("taken"));
    mocks.duePausesOf.mockImplementation(() => {
      order.push("due");
      return Promise.resolve([{ pauseId: "p-1" }]);
    });
    mocks.answeredPassOf.mockResolvedValue({ pass: "answered", resume: { values: { k: 1 } } });

    await expiredMove(parts, hooks as never, interrupted, {}, onTaken);

    expect(order).toEqual(["taken", "due"]);
    expect(hooks.announce).toHaveBeenCalledWith({ values: { k: 1 } }, STATE);
    expect(hooks.drained).toHaveBeenCalledWith(STATE, lease, {
      pass: "answered",
      resume: { values: { k: 1 } },
    });
    expect((lease as { release: () => void }).release).not.toHaveBeenCalled();
  });

  it("a move with no counter is as good", async () => {
    const { parts } = partsOf({ turns: [record(ExecutionRecordStatus.Paused)] });
    due();

    const hooks = hooksOf();

    await expiredMove(parts, hooks as never, interrupted, {});

    expect(hooks.drained).toHaveBeenCalledOnce();
  });

  it("a drain that was handed over, or whose run ended by its own outcome, is no failure of the expiry", async () => {
    for (const [error, turns] of [
      [
        new ExecutionLeaseLostError({ rootExecutionId: "root-1" }),
        [record(ExecutionRecordStatus.Paused)],
      ],
      [new Error("the run's own failure"), [record(ExecutionRecordStatus.Failed)]],
    ] as const) {
      const { parts, byIds } = partsOf({ turns: [record(ExecutionRecordStatus.Paused)] });
      byIds
        .mockResolvedValueOnce([record(ExecutionRecordStatus.Paused)])
        .mockResolvedValue([...turns]);
      const hooks = hooksOf();
      hooks.drained.mockRejectedValue(error);
      due();

      await expect(expiredMove(parts, hooks as never, interrupted, {})).resolves.toBeUndefined();
    }
  });

  it("a drain that failed for the machine's reasons: the failure is the look's, the lease given back", async () => {
    const { parts, lease, byIds } = partsOf();
    byIds.mockResolvedValue([record(ExecutionRecordStatus.Paused)]);
    const hooks = hooksOf();
    const failure = new Error("the store failed");
    hooks.drained.mockRejectedValue(failure);
    due();

    await expect(expiredMove(parts, hooks as never, interrupted, {})).rejects.toBe(failure);

    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
  });

  it("a drain that failed while the store's read throws synchronously (SQLite): the drain's failure is the look's, not the read's (#1375)", async () => {
    const { parts, lease, byIds } = partsOf();
    byIds.mockResolvedValueOnce([record(ExecutionRecordStatus.Paused)]).mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const hooks = hooksOf();
    const failure = new Error("the drain failed");
    hooks.drained.mockRejectedValue(failure);
    due();

    await expect(expiredMove(parts, hooks as never, interrupted, {})).rejects.toBe(failure);

    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
  });

  it("a failure while announcing: the lease given back, the failure the look's", async () => {
    const { parts, lease, byIds } = partsOf();
    byIds.mockResolvedValue([record(ExecutionRecordStatus.Paused)]);
    const hooks = hooksOf();
    hooks.announce.mockRejectedValue(new Error("the observer failed"));
    due();

    await expect(expiredMove(parts, hooks as never, interrupted, {})).rejects.toThrow(
      "the observer failed",
    );

    expect((lease as { release: () => void }).release).toHaveBeenCalledOnce();
    expect(hooks.drained).not.toHaveBeenCalled();
  });
});
