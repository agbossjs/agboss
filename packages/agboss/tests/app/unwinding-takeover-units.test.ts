/**
 * #633 (unwind shard) — a tree taken over mid-undo (`unwinding-takeover.ts`, #340 PR 4) and a
 * pass's root unwind (`tree-unwind.ts`) on their own: with the mark the undo is finished under the
 * new lease and logged, the lease released whatever happens; without it nothing ends; the sweep's
 * take is a takeover that skips a root whose record ended, `true` either way; and a pass without
 * compensation parts gets no root unwind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import type { CancelParts } from "../../src/app/cancel-requests.js";
import type { HeldExecutionLease } from "../../src/app/execution-leases.js";
import { unwindingDeps } from "../../src/app/tree-unwind.js";
import { endedUnwindingAtTake, endUnwindingIfFree } from "../../src/app/unwinding-takeover.js";
import { CompensationReason } from "../../src/flow/compensation.js";
import {
  markUnwinding,
  UNWINDING_KEY,
} from "../../src/flow/runtime/compensation/unwinding-marks.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";

const mocks = vi.hoisted(() => ({ endedWithoutPass: vi.fn(), unwoundTree: vi.fn() }));

vi.mock("../../src/app/ended-tree.js", () => ({ endedWithoutPass: mocks.endedWithoutPass }));
vi.mock("../../src/app/compensation/root-unwind.js", () => ({ unwoundTree: mocks.unwoundTree }));

const STATE = {
  runId: "root-1",
  threadId: "thread-1",
  tenantId: "acme",
  startedVersion: "1",
  ternId: "tern-1",
};
const TREE = { tenantId: "acme", rootExecutionId: "root-1" };

function leaseOf() {
  const release = vi.fn(() => Promise.resolve());
  const signal = new AbortController().signal;
  const lease = { release, signal } as never as HeldExecutionLease;
  return { lease, release, signal };
}

function partsOf(lease?: HeldExecutionLease) {
  const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
  const warn = vi.fn();
  const tryHold = vi.fn((_tree: unknown, _take: unknown) => Promise.resolve(lease));
  const parts = {
    trees,
    leases: { tryHold },
    deps: {
      log: { warn },
      pause: undefined,
      terns: { byIds: () => Promise.resolve([{ status: "failed" }]) },
    },
  } as never as CancelParts;
  return { parts, trees, warn, tryHold };
}

const marked = (trees: InMemoryExecutionTreeRepository) =>
  markUnwinding(
    { trees, tree: TREE, key: UNWINDING_KEY },
    { reason: CompensationReason.ExecutionFailed, cause: { name: "Error", message: "declined" } },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.endedWithoutPass.mockImplementation(
    (_parts: unknown, _state: unknown, end: { cause: Error }) =>
      Promise.resolve({ error: end.cause, isEnded: true }),
  );
});

describe("#633: a lease taken of a tree mid-undo", () => {
  it("with the mark: the undo finished under the new lease, logged, its error; the lease released", async () => {
    const { lease, release, signal } = leaseOf();
    const { parts, trees, warn } = partsOf();
    await marked(trees);

    const error = await endedUnwindingAtTake(parts, STATE, lease);

    expect(error?.message).toBe("declined");
    expect(mocks.endedWithoutPass.mock.calls[0]?.[2]).toMatchObject({ signal, lease });
    expect(warn).toHaveBeenCalledWith(
      "compensation.recovered",
      "execution root-1 is recovered: its automatic undo goes on, the undos done are skipped",
      { executionId: "root-1", tenantId: "acme" },
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("no mark: nothing ended, nothing logged; the lease released", async () => {
    const { lease, release } = leaseOf();
    const { parts, warn } = partsOf();

    expect(await endedUnwindingAtTake(parts, STATE, lease)).toBeUndefined();
    expect(mocks.endedWithoutPass).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("the undo throws: the lease released all the same", async () => {
    const { lease, release } = leaseOf();
    const { parts, trees } = partsOf();
    await marked(trees);
    mocks.endedWithoutPass.mockRejectedValue(new Error("store down"));

    await expect(endedUnwindingAtTake(parts, STATE, lease)).rejects.toThrow("store down");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("#633: the sweep's take of a root mid-undo", () => {
  it("a takeover for the undo, skipping a root whose record ended; true", async () => {
    const { lease } = leaseOf();
    const { parts, trees, tryHold } = partsOf(lease);
    await marked(trees);

    expect(await endUnwindingIfFree(parts, STATE)).toBe(true);
    const take = tryHold.mock.calls[0]?.[1] as {
      reason: string;
      isTakeover: boolean;
      isOver: () => Promise<boolean>;
    };
    expect(tryHold.mock.calls[0]?.[0]).toEqual(TREE);
    expect([take.reason, take.isTakeover, await take.isOver()]).toEqual([
      LeaseTakeoverReason.Unwinding,
      true,
      true,
    ]);
    expect(mocks.endedWithoutPass).toHaveBeenCalledOnce();
  });

  it("held elsewhere: nothing ended here; true", async () => {
    const { parts } = partsOf(undefined);

    expect(await endUnwindingIfFree(parts, STATE)).toBe(true);
    expect(mocks.endedWithoutPass).not.toHaveBeenCalled();
  });
});

describe("#633: a pass's root unwind", () => {
  it("no compensation parts: the deps as they are", () => {
    const deps = { compensation: undefined } as never as AppDeps;

    expect(
      unwindingDeps(deps, STATE, {
        signal: new AbortController().signal,
        lease: {} as never,
        undo: {},
      }),
    ).toBe(deps);
  });

  it("with them: the root unwind ends with the undo's error and keeps its records", async () => {
    mocks.unwoundTree.mockResolvedValue({
      error: new Error("undone"),
      compensations: [{ status: "x" }],
    });
    const deps = { compensation: { timeout: 1 } } as never as AppDeps;
    const undo = {};

    const leased = unwindingDeps(deps, STATE, {
      signal: new AbortController().signal,
      lease: {} as never,
      undo,
    });
    const error = await leased.compensation?.rootUnwind?.(new Error("declined"));

    expect((error as Error).message).toBe("undone");
    expect(undo).toEqual({ compensations: [{ status: "x" }] });
  });
});
