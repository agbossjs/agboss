/** #1341b, #1356 (WP6, unwind shard): a stop's end undoes nothing; any other failure's end is what the root's unwind says. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionStoppedError } from "../../src/app/lease-stopped.js";
import { undoneTreeEnd, unwindingDeps } from "../../src/app/tree-unwind.js";

const mocks = vi.hoisted(() => ({ unwoundTree: vi.fn() }));
vi.mock("../../src/app/compensation/root-unwind.js", () => ({ unwoundTree: mocks.unwoundTree }));

const deps = { tag: "deps" } as never;
const state = { tag: "state" } as never;
const signal = new AbortController().signal;
const lease = { tag: "lease" } as never;

beforeEach(() => {
  mocks.unwoundTree.mockReset();
});

describe("undoneTreeEnd", () => {
  it("a stop is the end as it is, and the tree's entries stay open: nothing is undone", async () => {
    const stop = new ExecutionStoppedError({ mode: "after-step" } as never);
    const undo: { compensations?: readonly unknown[] } = {};

    const end = await undoneTreeEnd(deps, state, { error: stop, signal, lease }, undo as never);

    expect(end).toBe(stop);
    expect(undo.compensations).toStrictEqual([]);
    expect(mocks.unwoundTree).not.toHaveBeenCalled();
  });

  it("an error caused by a stop is a stop too", async () => {
    const caused = new Error("outer", {
      cause: new ExecutionStoppedError({ mode: "immediate" } as never),
    });

    const end = await undoneTreeEnd(deps, state, { error: caused, signal, lease }, {});

    expect(end).toBe(caused);
    expect(mocks.unwoundTree).not.toHaveBeenCalled();
  });

  it("any other failure is undone by the root's unwind: its records kept, its error the end", async () => {
    const failure = new Error("the pass failed");
    const ended = new Error("an undo failed too");
    mocks.unwoundTree.mockResolvedValue({ compensations: [{ tag: "record" }], error: ended });
    const undo: { compensations?: readonly unknown[] } = {};

    const end = await undoneTreeEnd(deps, state, { error: failure, signal, lease }, undo as never);

    expect(end).toBe(ended);
    expect(undo.compensations).toStrictEqual([{ tag: "record" }]);
    expect(mocks.unwoundTree).toHaveBeenCalledExactlyOnceWith(deps, state, {
      cause: failure,
      signal,
      lease,
    });
  });
});

describe("unwindingDeps", () => {
  it("is the deps as they are when the application has no compensation parts", () => {
    const bare = { tag: "bare" } as never;

    expect(unwindingDeps(bare, state, { signal, lease, undo: {} })).toBe(bare);
  });

  it("gives the parts a root unwind that ends the tree with the error, and the pass's interruption", async () => {
    const failure = new Error("the pass failed");
    mocks.unwoundTree.mockResolvedValue({ compensations: [], error: failure });
    const interrupted = vi.fn();
    const undo = {};
    const own = { compensation: { timeout: 5 }, other: 1 } as never;

    const wrapped: Record<string, unknown> = {
      ...unwindingDeps(own, state, { signal, lease, undo, interrupted }),
    };
    const compensation = wrapped.compensation as {
      timeout: number;
      interrupted: unknown;
      rootUnwind: (e: unknown) => Promise<unknown>;
    };

    expect(wrapped.other).toBe(1);
    expect(compensation.timeout).toBe(5);
    expect(compensation.interrupted).toBe(interrupted);
    expect(await compensation.rootUnwind(failure)).toBe(failure);
    expect(mocks.unwoundTree).toHaveBeenCalledWith(own, state, { cause: failure, signal, lease });
  });
});
