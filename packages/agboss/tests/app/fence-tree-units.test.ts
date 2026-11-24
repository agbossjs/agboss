import { usd } from "../../src/units/index.js";
/**
 * #1366 (shard `fence-tree`) on their own: the end of a tree whose instance died (`orphan-tree.ts`) is made
 * only under the tree's lease, a resting one by the cancel path; a child's failure is announced only by the
 * pass that still holds the tree (`child-failure.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { orphanEndsOf } from "../../src/app/orphan-tree.js";
import { CompensationFailedError } from "../../src/flow/compensation.js";
import { RecordedError, errorRecordOf } from "../../src/core/error-record.js";
import { ChildExecutionFailedError } from "../../src/flow/runtime/child-errors.js";
import { assertAnnouncing, eventOf, failedChild } from "../../src/flow/runtime/child-failure.js";
import { HandOverSite } from "../../src/infrastructure/execution-audit-log.repository.js";
import { ChildExecutionStatus } from "../../src/flow/runtime/child-records.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";

const mocks = vi.hoisted(() => ({
  forgetTree: vi.fn(),
  endRestingCancelled: vi.fn(),
  wakeAnswered: vi.fn(),
  isFailureClaimed: vi.fn(),
  hasUndoableActions: vi.fn(),
  unwoundChild: vi.fn(),
}));
vi.mock("../../src/flow/runtime/child-reentry.js", () => ({
  isFailureClaimed: mocks.isFailureClaimed,
}));
vi.mock("../../src/flow/compensation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/flow/compensation.js")>()),
  hasUndoableActions: mocks.hasUndoableActions,
}));
vi.mock("../../src/flow/runtime/compensation/child-unwind.js", () => ({
  unwoundChild: mocks.unwoundChild,
}));
vi.mock("../../src/app/tree-ends.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/tree-ends.js")>()),
  forgetTree: mocks.forgetTree,
}));
vi.mock("../../src/app/cancel-resting.js", () => ({
  endRestingCancelled: mocks.endRestingCancelled,
}));
vi.mock("../../src/app/answered-wake.js", () => ({
  wakeAnsweredOf: () => mocks.wakeAnswered,
}));

const record = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "turn-1",
    runId: "root-1",
    threadId: "thread-1",
    tenantId: "acme",
    status: ExecutionRecordStatus.Failed,
    stopReason: "the model failed",
    configVersion: "2.0.0",
    ...overrides,
  }) as never;

function partsOf(lease: { release: () => Promise<void> } | undefined) {
  const tryHold = vi.fn(() => Promise.resolve(lease));
  const parts = {
    deps: { config: { version: "1.0.0" }, pause: undefined },
    leases: { tryHold },
    trees: {},
    clock: { now: () => new Date(0) },
  };
  return { parts: parts as never, tryHold };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forgetTree.mockResolvedValue(undefined);
  mocks.endRestingCancelled.mockResolvedValue(true);
  mocks.isFailureClaimed.mockResolvedValue(true);
  mocks.hasUndoableActions.mockReturnValue(false);
});

describe("#1366: the orphan look's end of a tree", () => {
  it("a record with no run: nothing is held, nothing ended, false", async () => {
    const release = vi.fn(() => Promise.resolve());
    const { parts, tryHold } = partsOf({ release });

    expect(await orphanEndsOf(parts).closeOrphan(record({ runId: null }))).toBe(false);

    expect(tryHold).not.toHaveBeenCalled();
    expect(mocks.forgetTree).not.toHaveBeenCalled();
    expect(mocks.endRestingCancelled).not.toHaveBeenCalled();
  });

  it("an ended root: the tree's lease taken as `recovered`, the whole tree forgotten on the record's cause, the lease released, true", async () => {
    const release = vi.fn(() => Promise.resolve());
    const { parts, tryHold } = partsOf({ release });

    expect(await orphanEndsOf(parts).closeOrphan(record())).toBe(true);

    expect(tryHold).toHaveBeenCalledOnce();
    expect(tryHold).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      expect.objectContaining({ reason: LeaseTakeoverReason.Recovered, isTakeover: false }),
    );
    expect(mocks.forgetTree).toHaveBeenCalledOnce();
    expect(mocks.forgetTree).toHaveBeenCalledWith(
      parts,
      { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "2.0.0" },
      expect.objectContaining({ message: "the model failed" }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.endRestingCancelled).not.toHaveBeenCalled();
  });

  it("a root whose record names no version: the workflow's version is the one it started on", async () => {
    const { parts } = partsOf({ release: () => Promise.resolve() });

    await orphanEndsOf(parts).closeOrphan(record({ configVersion: null }));

    expect(mocks.forgetTree).toHaveBeenCalledWith(
      parts,
      expect.objectContaining({ startedVersion: "1.0.0" }),
      expect.anything(),
    );
  });

  it("a cancelled root: its end is the cancel's, as app.cancel ends it", async () => {
    const { parts } = partsOf({ release: () => Promise.resolve() });

    await orphanEndsOf(parts).closeOrphan(record({ stopReason: "the run was cancelled" }));

    const [, , cause] = mocks.forgetTree.mock.calls[0] as [unknown, unknown, unknown];
    expect(cause).toBeInstanceOf(ExecutionCancelledError);
  });

  it("a lease held elsewhere: false, the tree left to a later look", async () => {
    const { parts, tryHold } = partsOf(undefined);

    expect(await orphanEndsOf(parts).closeOrphan(record())).toBe(false);

    expect(tryHold).toHaveBeenCalledOnce();
    expect(mocks.forgetTree).not.toHaveBeenCalled();
  });

  it("an end that throws: the lease is still released, the error is the look's", async () => {
    const release = vi.fn(() => Promise.resolve());
    const { parts } = partsOf({ release });
    mocks.forgetTree.mockRejectedValue(new Error("the store is down"));

    await expect(orphanEndsOf(parts).closeOrphan(record())).rejects.toThrow("the store is down");

    expect(release).toHaveBeenCalledOnce();
  });

  it("a root that rests (a cancel nobody finished): the cancel path ends it, no lease is taken here", async () => {
    const { parts, tryHold } = partsOf({ release: () => Promise.resolve() });
    mocks.endRestingCancelled.mockResolvedValue(false);

    const ended = await orphanEndsOf(parts).closeOrphan(
      record({ status: ExecutionRecordStatus.Paused }),
    );

    expect(ended).toBe(false);
    expect(mocks.endRestingCancelled).toHaveBeenCalledWith(parts, {
      runId: "root-1",
      threadId: "thread-1",
      tenantId: "acme",
      startedVersion: "2.0.0",
      turnId: "turn-1",
    });
    expect(tryHold).not.toHaveBeenCalled();
    expect(mocks.forgetTree).not.toHaveBeenCalled();
  });

  it("a resting root ended by the cancel path: true", async () => {
    const { parts } = partsOf(undefined);

    expect(
      await orphanEndsOf(parts).closeOrphan(record({ status: ExecutionRecordStatus.Paused })),
    ).toBe(true);
  });

  it("the second look is the answered-wake of the same parts", async () => {
    const { parts } = partsOf(undefined);

    expect(orphanEndsOf(parts).wakeAnswered).toBe(mocks.wakeAnswered);
  });
});

const ENDED = {
  identity: {
    executionId: "child-1",
    parentExecutionId: "root-1",
    rootExecutionId: "root-1",
    inheritedUsage: 0,
  },
  depth: 2,
  workflow: { name: "child-workflow", version: "1.0.0" },
  launchedBy: { nodeId: "child-workflow", visitNumber: 1 },
  start: "start",
  input: {},
  records: { components: new Map(), graph: { nodes: new Map() } },
};

function frameOf(
  lease: { assertHeld: () => void; recordHandOver?: () => void; scopeKey?: string } | undefined,
  signal: AbortSignal = new AbortController().signal,
) {
  const services = {
    reportUsage: vi.fn(),
    recordChild: vi.fn(),
    keepPiiTokens: vi.fn(),
    keepCompensations: vi.fn(),
  };
  const frame = {
    execution: {
      executionId: "child-1",
      workflow: {
        name: "child-workflow",
        version: "1.0.0",
        startedVersion: "1.0.0",
        configHash: "h",
      },
      threadId: "thread-1",
      tenant: { tenantId: "acme" },
      signal,
      ...(lease === undefined ? {} : { lease }),
    },
    step: {
      component: { type: "workflow", name: "child-workflow" },
      nodeId: "child-workflow",
      visitNumber: 1,
    },
    services,
  };
  return { frame: frame as never, services };
}

function parentOf(frame: never, overrides: Record<string, unknown> = {}) {
  const onExecutionError = vi.fn((_event: { error: Error }) => Promise.resolve());
  const record = vi.fn(() => Promise.resolve());
  const undo = {
    child: {
      deps: { graph: { nodes: new Map() }, observer: { onExecutionError } },
      workflow: ENDED.workflow,
    },
    run: {},
    budgets: { record },
    ...overrides,
  };
  return { parent: { deps: {}, frame, undo } as never, onExecutionError, record };
}

const stateOf = (usage: readonly unknown[] = []) =>
  ({
    usage,
    path: ["a"],
    toolCalls: [],
    stepRecords: [],
    children: [],
    piiTokens: { t: 1 },
  }) as never;

describe("#1366: a child's failure is announced only by the pass that holds the tree", () => {
  it("no lease (a unit runner): nothing stops the announcement", () => {
    expect(() => {
      assertAnnouncing(frameOf(undefined).frame);
    }).not.toThrow();
  });

  it("a lease still held: its own fence is read, nothing thrown", () => {
    const assertHeld = vi.fn();

    assertAnnouncing(frameOf({ assertHeld }).frame);

    expect(assertHeld).toHaveBeenCalledOnce();
  });

  it("a lease lost while the signal says so: the hand-over is recorded once for the child's site and thrown in place of the fence's error", () => {
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    const stop = new AbortController();
    stop.abort(lost);
    const recordHandOver = vi.fn();
    const assertHeld = (): void => {
      throw new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    };
    const { frame } = frameOf({ assertHeld, recordHandOver, scopeKey: "scope-1" }, stop.signal);

    expect(() => {
      assertAnnouncing(frame);
    }).toThrow(lost);

    expect(recordHandOver).toHaveBeenCalledOnce();
    expect(recordHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ error: lost, site: HandOverSite.Child }),
    );
  });

  it("an error that is no hand-over: thrown as it is, nothing recorded", () => {
    const recordHandOver = vi.fn();
    const failure = new Error("the clock failed");
    const { frame } = frameOf({
      assertHeld: () => {
        throw failure;
      },
      recordHandOver,
    });

    expect(() => {
      assertAnnouncing(frame);
    }).toThrow(failure);
    expect(recordHandOver).not.toHaveBeenCalled();
  });

  it("the child's events carry its ids, its thread and tenant and its workflow", () => {
    const { frame } = frameOf(undefined);

    expect(eventOf(frame, ENDED as never)).toEqual({
      executionId: "child-1",
      parentExecutionId: "root-1",
      rootExecutionId: "root-1",
      threadId: "thread-1",
      tenantId: "acme",
      workflow: ENDED.workflow,
    });
  });
});

describe("#1366: failedChild", () => {
  const failed = (parent: never, error: unknown, announces: boolean, last = stateOf()) =>
    failedChild(parent, ENDED as never, { error, last, announces }, {});

  it("a pass that does not announce: the failure thrown wrapped, its record kept, no fence read, no claim, no event", async () => {
    const assertHeld = vi.fn();
    const { frame, services } = frameOf({ assertHeld });
    const { parent, onExecutionError } = parentOf(frame);
    const boom = new Error("the child failed");

    const thrown = await failed(parent, boom, false).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChildExecutionFailedError);
    expect(services.recordChild).toHaveBeenCalledOnce();
    expect(services.recordChild).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "child-1", status: ChildExecutionStatus.Failed }),
    );
    expect(services.keepPiiTokens).toHaveBeenCalledWith({ t: 1 });
    expect(assertHeld).not.toHaveBeenCalled();
    expect(mocks.isFailureClaimed).not.toHaveBeenCalled();
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("a child with no state: no tokens are kept", async () => {
    const { frame, services } = frameOf({ assertHeld: vi.fn() });
    const { parent } = parentOf(frame);

    const thrown = await failedChild(
      parent,
      ENDED as never,
      { error: new Error("x"), last: undefined, announces: false },
      {},
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChildExecutionFailedError);
    expect(services.keepPiiTokens).not.toHaveBeenCalled();
    expect(services.recordChild).toHaveBeenCalledOnce();
  });

  it("an announcing pass that wins the claim: the fence checked before and after, the event masked by the child's own chain, the failure thrown", async () => {
    const assertHeld = vi.fn();
    const { frame } = frameOf({ assertHeld });
    const { parent, onExecutionError } = parentOf(frame);
    const boom = new Error("the child failed");

    const thrown = await failed(parent, boom, true).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChildExecutionFailedError);
    expect(assertHeld).toHaveBeenCalledTimes(2);
    expect(mocks.isFailureClaimed).toHaveBeenCalledWith(
      (parent as { deps: unknown }).deps,
      ENDED.identity,
      "acme",
      boom,
    );
    expect(onExecutionError).toHaveBeenCalledOnce();
    expect(onExecutionError).toHaveBeenCalledWith({
      ...eventOf(frame, ENDED as never),
      error: thrown,
      compensations: [],
    });
  });

  it("a claim another pass won: no event, the failure thrown after one fence check", async () => {
    const assertHeld = vi.fn();
    const { frame } = frameOf({ assertHeld });
    const { parent, onExecutionError } = parentOf(frame);
    mocks.isFailureClaimed.mockResolvedValue(false);

    const thrown = await failed(parent, new Error("x"), true).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ChildExecutionFailedError);
    expect(assertHeld).toHaveBeenCalledOnce();
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("a lease lost at the first look: the hand-over is thrown, nothing claimed", async () => {
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    const stop = new AbortController();
    stop.abort(lost);
    const { frame } = frameOf(
      {
        assertHeld: () => {
          throw lost;
        },
      },
      stop.signal,
    );
    const { parent, onExecutionError } = parentOf(frame);

    await expect(failed(parent, new Error("x"), true)).rejects.toThrow(lost);

    expect(mocks.isFailureClaimed).not.toHaveBeenCalled();
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("a lease lost after the claim round trip: the hand-over is thrown, no event", async () => {
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    const stop = new AbortController();
    stop.abort(lost);
    let looks = 0;
    const { frame } = frameOf(
      {
        assertHeld: () => {
          looks += 1;
          if (looks === 2) throw lost;
        },
      },
      stop.signal,
    );
    const { parent, onExecutionError } = parentOf(frame);

    await expect(failed(parent, new Error("x"), true)).rejects.toThrow(lost);

    expect(mocks.isFailureClaimed).toHaveBeenCalledOnce();
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("a cancelled child: the claim is made on the cancel that is thrown, not on the error the child met", async () => {
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const { parent } = parentOf(frame);
    const own = new ExecutionCancelledError({ message: "stopped" });

    const thrown = await failed(parent, own, true).catch((error: unknown) => error);

    expect(thrown).toBe(own);
    expect(mocks.isFailureClaimed).toHaveBeenCalledWith(
      expect.anything(),
      ENDED.identity,
      "acme",
      own,
    );
  });

  it("a cancelled child by its signal: the cancel it is given is the claim's cause", async () => {
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const { parent } = parentOf(frame);
    const stop = new AbortController();
    stop.abort(new Error("the launch was aborted"));

    const thrown = await failedChild(
      parent,
      ENDED as never,
      { error: new Error("boom"), last: stateOf(), announces: true },
      { signal: stop.signal },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ExecutionCancelledError);
    expect(mocks.isFailureClaimed).toHaveBeenCalledWith(
      expect.anything(),
      ENDED.identity,
      "acme",
      thrown,
    );
  });

  it("the spend a failure reports goes to the parent's step, once each", async () => {
    const { frame, services } = frameOf({ assertHeld: vi.fn() });
    const { parent, record } = parentOf(frame);
    const spend = [{ costUsd: usd(1) }, { costUsd: usd(2) }] as never;

    await failed(
      parent,
      new ExecutionCancelledError({ message: "stopped" }),
      false,
      stateOf(spend),
    ).catch(() => undefined);

    expect(services.reportUsage).toHaveBeenCalledTimes(2);
    expect(services.reportUsage).toHaveBeenNthCalledWith(1, { costUsd: usd(1) });
    expect(services.reportUsage).toHaveBeenNthCalledWith(2, { costUsd: usd(2) });
    expect(record).not.toHaveBeenCalled();
  });

  it("a failed undo carries no spend: it is written to the ledger now — by class and by record, never for another error", async () => {
    const spend = [{ costUsd: usd(3) }] as never;
    const undoFailed = new CompensationFailedError({ failures: [], cause: undefined });
    const recorded = new RecordedError(errorRecordOf(undoFailed));
    for (const [error, isWritten] of [
      [undoFailed, true],
      [recorded, true],
      [new Error("other"), false],
    ] as const) {
      const { frame, services } = frameOf({ assertHeld: vi.fn() });
      const { parent, record } = parentOf(frame);

      await failed(parent, error, false, stateOf(spend)).catch(() => undefined);

      expect(record).toHaveBeenCalledTimes(isWritten ? 1 : 0);
      if (isWritten) expect(record).toHaveBeenCalledWith(spend);
      expect(services.reportUsage).not.toHaveBeenCalled();
    }
  });

  it("a child whose workflow declares an undo: undone first, its closed entries kept, its error and records the parent gets", async () => {
    mocks.hasUndoableActions.mockReturnValue(true);
    const undone = new Error("undone");
    mocks.unwoundChild.mockResolvedValue({ thrown: undone, closed: [] });
    const { frame, services } = frameOf({ assertHeld: vi.fn() });
    const { parent, onExecutionError } = parentOf(frame);

    const thrown = await failed(parent, new Error("x"), true).catch((error: unknown) => error);

    expect(thrown).toBe(undone);
    expect(mocks.unwoundChild).toHaveBeenCalledOnce();
    expect(mocks.unwoundChild).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "child-1", parent: frame }),
      expect.any(ChildExecutionFailedError),
    );
    expect(services.keepCompensations).toHaveBeenCalledWith([]);
    expect(onExecutionError).toHaveBeenCalledWith(expect.objectContaining({ error: undone }));
  });

  it("a thrown value that is no Error is announced as one made of the child's own error", async () => {
    mocks.hasUndoableActions.mockReturnValue(true);
    mocks.unwoundChild.mockResolvedValue({ thrown: "plain text", closed: [] });
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const { parent, onExecutionError } = parentOf(frame);

    await failed(parent, new Error("the child's own"), true).catch(() => undefined);

    const event = onExecutionError.mock.calls[0]?.[0];
    expect(event?.error).toBeInstanceOf(Error);
    expect(event?.error.message).toBe("Error: the child's own");
  });

  it("the entries the child's own state holds are the ones its error event lists", async () => {
    const entry = { executionId: "child-1", undo: [{ id: "u1" }] };
    const other = { executionId: "elsewhere", undo: [{ id: "u2" }] };
    const last = { ...(stateOf() as object), compensations: [entry, other] } as never;
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const { parent, onExecutionError } = parentOf(frame);

    await failed(parent, new Error("x"), true, last).catch(() => undefined);

    expect(onExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ compensations: [{ id: "u1" }] }),
    );
  });
});

describe("#1366: failedChild of a child that has nothing to hand its parent", () => {
  it("a parent whose frame has no side paths (a unit runner): the failure is still thrown, whatever is missing", async () => {
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const bare = { ...(frame as object), services: {} } as never;
    const parent = {
      deps: {},
      frame: bare,
      undo: { child: { deps: { graph: { nodes: new Map() } }, workflow: ENDED.workflow }, run: {} },
    } as never;
    const own = new ExecutionCancelledError({ message: "stopped" });
    const spend = [{ costUsd: usd(1) }] as never;

    for (const announces of [false, true]) {
      const thrown = await failedChild(
        parent,
        ENDED as never,
        { error: own, last: stateOf(spend), announces },
        {},
      ).catch((error: unknown) => error);
      expect(thrown).toBe(own);
    }
    const undoFailed = new CompensationFailedError({ failures: [], cause: undefined });
    await expect(
      failedChild(
        parent,
        ENDED as never,
        { error: undoFailed, last: stateOf(spend), announces: false },
        {},
      ),
    ).rejects.toBe(undoFailed);
  });

  it("an undo that runs gets the child's graph, workflow, run, ids, the frame, the checkpointer, the budgets, the entries it holds and the error", async () => {
    mocks.hasUndoableActions.mockReturnValue(true);
    mocks.unwoundChild.mockResolvedValue({ thrown: new Error("undone"), closed: [] });
    const { frame, services } = frameOf({ assertHeld: vi.fn() });
    const checkpointer = { id: "saver" };
    const run = { runId: "run-ctx" };
    const budgets = { record: vi.fn() };
    const { parent } = parentOf(frame, { checkpointer, run, budgets });
    const entries = [{ executionId: "child-1", undo: [{ id: "u1" }] }];
    const last = { ...(stateOf() as object), compensations: entries } as never;
    const config = { configurable: { x: 1 } };
    const error = new Error("boom");

    await failedChild(parent, ENDED as never, { error, last, announces: false }, config).catch(
      () => undefined,
    );

    expect(mocks.unwoundChild).toHaveBeenCalledWith(
      {
        deps: (parent as { undo: { child: { deps: unknown } } }).undo.child.deps,
        workflow: ENDED.workflow,
        run,
        executionId: "child-1",
        parent: frame,
        config,
        checkpointer,
        budgets,
        last: entries,
        error,
      },
      expect.any(ChildExecutionFailedError),
    );
    expect(services.keepCompensations).toHaveBeenCalledWith([]);
  });

  it("an undo of a child with no state: no entries held, none kept, the frame needs no side path for them", async () => {
    mocks.hasUndoableActions.mockReturnValue(true);
    mocks.unwoundChild.mockResolvedValue({ thrown: new Error("undone"), closed: [] });
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const bare = { ...(frame as object), services: {} } as never;
    const { parent } = parentOf(bare);

    await expect(
      failedChild(
        parent,
        ENDED as never,
        { error: new Error("x"), last: undefined, announces: false },
        {},
      ),
    ).rejects.toThrow("undone");

    expect(mocks.unwoundChild).toHaveBeenCalledWith(
      expect.objectContaining({ last: [] }),
      expect.anything(),
    );
  });

  it("the entries the undo closed are listed with the child's own in its error event, and kept for the parent", async () => {
    mocks.hasUndoableActions.mockReturnValue(true);
    const closed = [{ executionId: "child-1", undo: [{ id: "u2" }] }];
    mocks.unwoundChild.mockResolvedValue({ thrown: new Error("undone"), closed });
    const own = { executionId: "child-1", undo: [{ id: "u1" }] };
    const other = { executionId: "elsewhere", undo: [{ id: "u0" }] };
    const last = { ...(stateOf() as object), compensations: [own, other] } as never;
    const { frame, services } = frameOf({ assertHeld: vi.fn() });
    const { parent, onExecutionError } = parentOf(frame);

    await failedChild(
      parent,
      ENDED as never,
      { error: new Error("x"), last, announces: true },
      {},
    ).catch(() => undefined);

    expect(services.keepCompensations).toHaveBeenCalledWith(closed);
    expect(onExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ compensations: [{ id: "u1" }, { id: "u2" }] }),
    );
  });

  it("a child with no observer announces to nobody and still throws", async () => {
    const { frame } = frameOf({ assertHeld: vi.fn() });
    const { parent } = parentOf(frame, {
      child: { deps: { graph: { nodes: new Map() } }, workflow: ENDED.workflow },
    });

    await expect(
      failedChild(
        parent,
        ENDED as never,
        { error: new Error("x"), last: stateOf(), announces: true },
        {},
      ),
    ).rejects.toBeInstanceOf(ChildExecutionFailedError);
  });
});
