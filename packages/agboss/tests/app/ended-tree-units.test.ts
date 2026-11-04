/**
 * #633 (recovery shard) — a tree ended without a pass (`ended-tree.ts`) on its own: the call that
 * fails its record observes `onExecutionError` once, with what the undo ran — an empty list when it
 * ran nothing —, and a call that did not fail the record observes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { endedWithoutPass, type EndedTreeParts } from "../../src/app/ended-tree.js";

vi.mock("../../src/app/compensation/root-unwind.js", () => ({
  markTreeUnwinding: () => Promise.resolve(),
}));
vi.mock("../../src/app/tree-unwind.js", () => ({
  undoneTreeEnd: (_deps: unknown, _state: unknown, failure: { error: Error }) =>
    Promise.resolve(failure.error),
}));
vi.mock("../../src/app/tree-ends.js", () => ({ forgetTree: () => Promise.resolve() }));
vi.mock("../../src/app/execution-history.js", () => ({
  keepExecutionRecord: () => Promise.resolve(),
  historyEndOf: () => ({}),
}));
vi.mock("../../src/app/run-events.js", () => ({
  executionEventAt: () => ({ executionId: "root-1" }),
}));

const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };

function partsOf(isFailedHere: boolean) {
  const onExecutionError = vi.fn(() => Promise.resolve());
  const deps: AppDeps = {
    terns: {
      lastTerns: () => Promise.resolve([{ id: "tern-1", runId: "root-1", route: [], costUsd: 0 }]),
      completeIfStatus: vi.fn(() => Promise.resolve(isFailedHere)),
    },
    observer: { onExecutionError },
  } as never;
  const parts: EndedTreeParts = {
    deps,
    paused: { find: () => Promise.resolve(undefined), drop: vi.fn() },
  } as never;
  return { parts, onExecutionError };
}

const end = () => ({
  cause: new Error("declined"),
  signal: new AbortController().signal,
  lease: {} as never,
});

describe("#633: endedWithoutPass", () => {
  it("an undo that ran nothing: onExecutionError lists no undo", async () => {
    const { parts, onExecutionError } = partsOf(true);

    const ended = await endedWithoutPass(parts, STATE, end());

    expect(ended.isEnded).toBe(true);
    expect(onExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ compensations: [], error: ended.error }),
    );
  });

  it("what the undo ran: listed as it ran", async () => {
    const { parts, onExecutionError } = partsOf(true);
    const compensations = [{ status: "compensated" }] as never;

    await endedWithoutPass(parts, STATE, { ...end(), undo: { compensations } });

    expect(onExecutionError).toHaveBeenCalledWith(expect.objectContaining({ compensations }));
  });

  it("the record ended by another call: nothing observed", async () => {
    const { parts, onExecutionError } = partsOf(false);

    expect((await endedWithoutPass(parts, STATE, end())).isEnded).toBe(false);
    expect(onExecutionError).not.toHaveBeenCalled();
  });
});
