/**
 * #1366 (shard `fence-checkpoint`): one pass of a tree is observed and settled while its lease is held — its
 * signals are the lease's, the cancel's and the instance's, its outcome is announced only while the lease is
 * still held (a holder that froze past its lease stops at its own fence, a hand-over, announcing nothing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observedPass } from "../../src/app/observed-pass.js";

const mocks = vi.hoisted(() => ({
  observeLeg: vi.fn(),
  executionEventAt: vi.fn(),
  unwindingDeps: vi.fn(),
  leasedDeps: vi.fn(),
  runResultOf: vi.fn(),
  maskedRecordOf: vi.fn(),
  maskedPendingOf: vi.fn(),
  nodeRecordIn: vi.fn(),
}));
vi.mock("../../src/app/run-events.js", () => ({
  observeLeg: mocks.observeLeg,
  executionEventAt: mocks.executionEventAt,
}));
vi.mock("../../src/app/tree-unwind.js", () => ({ unwindingDeps: mocks.unwindingDeps }));
vi.mock("../../src/app/tree-ends.js", () => ({ leasedDeps: mocks.leasedDeps }));
vi.mock("../../src/app/result.js", () => ({
  runResultOf: mocks.runResultOf,
  maskedRecordOf: mocks.maskedRecordOf,
}));
vi.mock("../../src/app/record-masks.js", () => ({ maskedPendingOf: mocks.maskedPendingOf }));
vi.mock("../../src/flow/runtime/workflow-keys.js", () => ({ nodeRecordIn: mocks.nodeRecordIn }));

const STATE = { runId: "root-1", threadId: "t-1", tenantId: "acme", startedVersion: "1" };

function setup(
  options: { callSignal?: AbortSignal; record?: boolean; compensations?: unknown[] } = {},
) {
  const lease = new AbortController();
  const watch = new AbortController();
  const interruption = new AbortController();
  const assertHeld = vi.fn();
  const held = {
    lease: { signal: lease.signal, assertHeld },
    watch: { signal: watch.signal },
    undo: options.compensations === undefined ? {} : { compensations: options.compensations },
  };
  const tracked: { signal?: AbortSignal; state?: unknown } = {};
  const live = {
    interruption: interruption.signal,
    track: vi.fn(
      async (
        state: unknown,
        signal: AbortSignal,
        work: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        tracked.signal = signal;
        tracked.state = state;
        return work(signal);
      },
    ),
  };
  const settle = vi.fn(() => Promise.resolve());
  const deps = { observer: { id: "observer" } };
  const parts = { deps, live, paused: { settle } };
  const pass = vi.fn((_deps: unknown, _signal: AbortSignal) => Promise.resolve({ path: ["a"] }));
  const call = {
    ...(options.callSignal === undefined ? {} : { signal: options.callSignal }),
    ...(options.record === undefined ? {} : { includeRecord: options.record }),
  };
  return {
    parts,
    held,
    call,
    pass,
    lease,
    watch,
    interruption,
    assertHeld,
    tracked,
    live,
    settle,
    deps,
  };
}

const run = (s: ReturnType<typeof setup>) =>
  observedPass(s.parts as never, STATE, s.call, s.held as never, s.pass as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executionEventAt.mockReturnValue("the event");
  mocks.leasedDeps.mockReturnValue("leased deps");
  mocks.unwindingDeps.mockReturnValue("moving deps");
  mocks.runResultOf.mockReturnValue("the result");
  mocks.maskedRecordOf.mockReturnValue("the masked output");
  mocks.maskedPendingOf.mockReturnValue("masked pending");
  // observeLeg runs the leg it is given, as the real one does
  mocks.observeLeg.mockImplementation(
    (_observer: unknown, _event: unknown, leg: () => Promise<unknown>) => leg(),
  );
});

describe("#1366: one pass of a tree, observed and settled", () => {
  it("the pass runs on the leased deps made unwinding, tracked for the tree's thread; its record is masked and is the output", async () => {
    const s = setup();

    expect(await run(s)).toBe("the masked output");

    expect(mocks.leasedDeps).toHaveBeenCalledWith(s.deps, s.held.lease);
    expect(mocks.unwindingDeps).toHaveBeenCalledWith("leased deps", STATE, {
      signal: expect.any(AbortSignal),
      lease: s.held.lease,
      undo: s.held.undo,
      interrupted: expect.any(Function),
    });
    expect(s.tracked.state).toBe(STATE);
    expect(s.pass).toHaveBeenCalledOnce();
    expect(s.pass.mock.calls[0]?.[0]).toBe("moving deps");
    expect(s.pass.mock.calls[0]?.[1]).toBe(s.tracked.signal);
    expect(s.settle).toHaveBeenCalledWith({ path: ["a"] });
    expect(mocks.runResultOf).toHaveBeenCalledWith({ path: ["a"] }, false, expect.any(Function));
    expect(mocks.maskedRecordOf).toHaveBeenCalledWith("the result", s.deps);
  });

  it("the pause is settled before the result is read", async () => {
    const s = setup();
    const order: string[] = [];
    s.settle.mockImplementation(() => {
      order.push("settle");
      return Promise.resolve();
    });
    mocks.runResultOf.mockImplementation(() => {
      order.push("result");
      return "the result";
    });

    await run(s);

    expect(order).toEqual(["settle", "result"]);
  });

  it("a record is asked for only by a call that says so (`includeRecord: true`), and read per node of the deps", async () => {
    for (const [record, expected] of [
      [true, true],
      [false, false],
      [undefined, false],
    ] as const) {
      mocks.runResultOf.mockClear();
      await run(setup(record === undefined ? {} : { record }));

      const [, asked, nodeRecord] = mocks.runResultOf.mock.calls[0] as [
        unknown,
        boolean,
        (name: string) => unknown,
      ];
      expect(asked).toBe(expected);
      mocks.nodeRecordIn.mockReturnValue("the node's record");
      expect(nodeRecord("clerk")).toBe("the node's record");
      expect(mocks.nodeRecordIn).toHaveBeenLastCalledWith(
        { observer: { id: "observer" } },
        "clerk",
      );
    }
  });

  it("the tracked signal ends with the lease, the cancel watch, and the caller's own signal when there is one", async () => {
    for (const source of ["lease", "watch", "call"] as const) {
      const caller = new AbortController();
      const s = setup({ callSignal: caller.signal });
      await run(s);
      expect(s.tracked.signal?.aborted).toBe(false);

      ({ lease: s.lease, watch: s.watch, call: caller })[source].abort();

      expect(s.tracked.signal?.aborted).toBe(true);
    }
  });

  it("with no caller signal the tracked signal ends with the lease or the watch only, and not with the instance's interruption", async () => {
    const s = setup();
    await run(s);

    s.interruption.abort();
    expect(s.tracked.signal?.aborted).toBe(false);
    s.watch.abort();
    expect(s.tracked.signal?.aborted).toBe(true);
  });

  it("the signal of the pass's undo ends with the lease or the instance's stop — never with a cancel, the watch or the caller", async () => {
    const caller = new AbortController();
    const s = setup({ callSignal: caller.signal });
    await run(s);
    const { signal } = mocks.unwindingDeps.mock.calls[0]?.[2] as { signal: AbortSignal };

    caller.abort();
    s.watch.abort();
    expect(signal.aborted).toBe(false);
    s.interruption.abort();
    expect(signal.aborted).toBe(true);

    const other = setup();
    await run(other);
    const second = mocks.unwindingDeps.mock.calls[1]?.[2] as { signal: AbortSignal };
    other.lease.abort();
    expect(second.signal.aborted).toBe(true);
  });

  it("the leg is observed with the observer, the tree's event, and the compensations and pending a pass's failure or pause reports", async () => {
    const s = setup({ compensations: [{ id: "u1" }] });

    await run(s);

    const [observer, event, , compensations, pending] = mocks.observeLeg.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      () => unknown,
      (pending: unknown) => unknown,
    ];
    expect(observer).toBe(s.deps.observer);
    expect(event).toBe("the event");
    expect(mocks.executionEventAt).toHaveBeenCalledWith(STATE, s.deps);
    expect(compensations()).toEqual([{ id: "u1" }]);
    expect(pending("what waits")).toBe("masked pending");
    expect(mocks.maskedPendingOf).toHaveBeenCalledWith(s.deps, "what waits");
  });

  it("a pass whose undo ran nothing reports no compensations: an empty list", async () => {
    const s = setup();

    await run(s);

    const compensations = mocks.observeLeg.mock.calls[0]?.[3] as () => unknown;
    expect(compensations()).toEqual([]);
  });
});

describe("#1366: the outcome is announced only while the lease is held", () => {
  it("a leg that ended: the fence is read once after it, and its result is the outcome", async () => {
    const s = setup();

    expect(await run(s)).toBe("the masked output");

    expect(s.assertHeld).toHaveBeenCalledOnce();
  });

  it("a holder that froze past its lease: the leg's result is not announced, the fence's hand-over is thrown", async () => {
    const s = setup();
    const lost = new Error("the lease was lost");
    s.assertHeld.mockImplementation(() => {
      throw lost;
    });

    await expect(run(s)).rejects.toBe(lost);
  });

  it("a leg that failed: the fence is read first; a lost lease replaces the failure, else the failure is thrown", async () => {
    const failure = new Error("the leg failed");
    const held = setup();
    failingWith(held, failure);
    await expect(run(held)).rejects.toBe(failure);
    expect(held.assertHeld).toHaveBeenCalledOnce();

    const lostLease = setup();
    failingWith(lostLease, failure);
    const lost = new Error("the lease was lost");
    lostLease.assertHeld.mockImplementation(() => {
      throw lost;
    });
    await expect(run(lostLease)).rejects.toBe(lost);
  });
});

function failingWith(s: ReturnType<typeof setup>, error: Error): void {
  s.pass.mockRejectedValue(error);
}
