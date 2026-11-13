/**
 * #633 (recovery shard) — a pass's deps and a tree's end (`tree-ends.ts`) on their own: the pass's
 * checkpoint writes renew its lease, its remote waits yield it and its children's deps carry it —
 * only where the deps have them —; an ended tree forgets its keys, its queued children, its branch
 * errors and its pauses, and a pass that ended forgets its undo mirror; parts an application lacks
 * are skipped.
 */
import { describe, expect, it, vi } from "vitest";
import type { HeldExecutionLease } from "../../src/app/execution-leases.js";
import { forgetTree, leasedGraphDeps, passEnded } from "../../src/app/tree-ends.js";
import type { GraphDeps } from "../../src/graph/deps.js";

const mocks = vi.hoisted(() => ({ closeTreePauses: vi.fn(() => Promise.resolve()) }));

vi.mock("../../src/app/tree-end-pauses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/tree-end-pauses.js")>()),
  closeTreePauses: mocks.closeTreePauses,
}));

const END = { cause: new Error("ended") };

const yieldWhile = vi.fn(<T>(wait: () => Promise<T>) => wait());
const lease = { yieldWhile } as never;

const graphDeps = (parts: Record<string, unknown>) => parts as never;

const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };

describe("#633: leasedGraphDeps", () => {
  it("no pause store: the deps with the lease only", () => {
    const deps = graphDeps({ graph: "g" });

    expect(leasedGraphDeps(deps, lease)).toEqual({ graph: "g", lease });
  });

  it("a pause store but no remote children nor children: no yield and no child deps made up", () => {
    const leased = leasedGraphDeps(graphDeps({ pause: { checkpointer: {} } }), lease);

    expect(Object.keys(leased).sort()).toEqual(["lease", "pause"]);
  });

  it("remote children: their waits yield the pass's lease", async () => {
    const deps = graphDeps({ pause: { checkpointer: {} }, remoteChildren: { queue: "q" } });
    const leased = leasedGraphDeps(deps, lease);

    await expect(leased.remoteChildren?.yieldWhile?.(() => Promise.resolve(7))).resolves.toBe(7);
    expect(yieldWhile).toHaveBeenCalledOnce();
    expect(leased.remoteChildren).toMatchObject({ queue: "q" });
  });

  it("children: each child's deps leased as well; a workflow with none stays none", () => {
    const child = graphDeps({ graph: "child" });
    const deps = graphDeps({
      pause: { checkpointer: {} },
      childDepsOf: (workflow: unknown) => (workflow === "known" ? child : undefined),
    });
    const leased = leasedGraphDeps(deps, lease);

    expect(leased.childDepsOf?.("known" as never)).toEqual({ graph: "child", lease });
    expect(leased.childDepsOf?.("unknown" as never)).toBeUndefined();
  });
});

describe("#633: forgetTree and passEnded", () => {
  it("an application without queue, branch errors or pauses: only its keys go", async () => {
    const deleteAllInTree = vi.fn(() => Promise.resolve());
    mocks.closeTreePauses.mockClear();

    await forgetTree(
      { deps: {}, trees: { deleteAllInTree }, clock: { now: () => new Date(0) } } as never,
      STATE,
      END.cause,
    );

    expect(deleteAllInTree).toHaveBeenCalledWith({ tenantId: "acme", rootExecutionId: "root-1" });
    expect(mocks.closeTreePauses).not.toHaveBeenCalled();
  });

  it("with all of them: the queued children, branch errors and waiting pauses go too", async () => {
    const deleteAllByTenantIdAndRootExecutionId = vi.fn(() => Promise.resolve());
    const forgetExecution = vi.fn();
    const pause = { pauses: {} };
    mocks.closeTreePauses.mockClear();
    const deps = {
      remoteChildren: { queue: { deleteAllByTenantIdAndRootExecutionId } },
      branchErrors: { forgetExecution },
      pause,
    };

    await forgetTree(
      {
        deps,
        trees: { deleteAllInTree: () => Promise.resolve() },
        clock: { now: () => new Date(0) },
      } as never,
      STATE,
      END.cause,
    );

    expect(deleteAllByTenantIdAndRootExecutionId).toHaveBeenCalledWith("acme", "root-1");
    expect(forgetExecution).toHaveBeenCalledWith("root-1");
    expect(mocks.closeTreePauses).toHaveBeenCalledWith(
      expect.objectContaining({ stores: pause }),
      { tenantId: "acme", rootExecutionId: "root-1", threadId: "thread-1" },
      END,
      new Date(0),
    );
  });

  it("a tree that finished closes a pause it still had with the finish as its cause; an end that is no Error is made one", async () => {
    mocks.closeTreePauses.mockClear();
    const parts = {
      deps: { pause: { pauses: {} } },
      trees: { deleteAllInTree: () => Promise.resolve() },
      clock: { now: () => new Date(0) },
    } as never;

    await forgetTree(parts, STATE);
    await forgetTree(parts, STATE, "boom");
    await forgetTree(parts, STATE, END.cause);

    const causes = mocks.closeTreePauses.mock.calls.map((call) => (call as unknown[])[2]);
    expect(causes).toEqual([
      { cause: new Error("the tree finished") },
      { cause: new Error("boom") },
      { cause: END.cause },
    ]);
  });

  it("a pass ended: its bodies awaited, its undo mirror forgotten — none without compensation", async () => {
    const stepsClosed = vi.fn(() => Promise.resolve());
    const forget = vi.fn();

    await passEnded({ stepsClosed }, { stepEntries: undefined, compensation: undefined }, STATE);
    await passEnded(
      { stepsClosed },
      { stepEntries: undefined, compensation: { registry: { forget } } } as never,
      STATE,
    );

    expect(stepsClosed).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledWith({ tenantId: "acme", rootExecutionId: "root-1" });
  });
});
