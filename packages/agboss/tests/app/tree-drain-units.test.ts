/**
 * #1356 (shard `recovery`) — how a drained tree stands in its kept record (`tree-drain.ts`), on its own: a tree that
 * finished or failed keeps the rest its status says, one a cancel ended keeps the cancel's error and the undo it ran,
 * and only a tree that ended is forgotten — a paused one keeps its keys and its lease is simply given back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainTree } from "../../src/app/tree-drain.js";
import { ExecutionStatus } from "../../src/app/types.js";

const mocks = vi.hoisted(
  (): { result: unknown; cause: unknown; kept: unknown[][]; forgotten: unknown[][] } => ({
    result: undefined,
    cause: undefined,
    kept: [],
    forgotten: [],
  }),
);
vi.mock("../../src/app/drain-passes.js", () => ({
  passesOf: () => Promise.resolve(mocks.result),
}));
vi.mock("../../src/app/cancel-watch.js", () => ({
  cancelWatchOf: () => "watch",
  watchedBy: () => () => undefined,
}));
vi.mock("../../src/app/cancelled-output.js", () => ({ cancelCauseOf: () => mocks.cause }));
vi.mock("../../src/app/execution-history.js", () => ({
  keepExecutionRecord: (...args: unknown[]) => {
    mocks.kept.push(args);
    return Promise.resolve();
  },
  historyEndOf: (cause: unknown, compensations: unknown) => ({ ended: cause, compensations }),
  historyRestOf: (status: unknown) => ({ rest: status }),
}));
vi.mock("../../src/app/tree-ends.js", () => ({
  forgetTree: (...args: unknown[]) => {
    mocks.forgotten.push(args);
    return Promise.resolve();
  },
  passEnded: () => Promise.resolve(),
}));
vi.mock("../../src/app/result.js", () => ({
  withPauseAnswers: (result: unknown) => Promise.resolve(result),
}));

const STATE = { runId: "root-1", threadId: "t-1", tenantId: "acme", startedVersion: "1" };

const drained = async (status: ExecutionStatus) => {
  mocks.result = { status };
  const release = vi.fn(() => Promise.resolve());
  const parts = { deps: { log: { warn: vi.fn() } }, trees: {}, leases: {}, live: {} } as never;
  const output = await drainTree(
    parts,
    {} as never,
    { state: STATE, call: {} },
    {
      lease: { release } as never,
      first: {} as never,
    },
  );
  return { output, release, parts };
};

beforeEach(() => {
  mocks.kept.length = 0;
  mocks.forgotten.length = 0;
  mocks.cause = undefined;
});

describe("#699: the kept record of a drained tree", () => {
  it("a tree that ended with no cancel keeps the rest its status says, and is forgotten under no cause", async () => {
    const { output, release, parts } = await drained(ExecutionStatus.Finished);

    expect(output).toEqual({ status: ExecutionStatus.Finished });
    expect(mocks.kept).toEqual([[expect.anything(), STATE, { rest: ExecutionStatus.Finished }]]);
    expect(mocks.forgotten).toEqual([[parts, STATE, undefined]]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("a tree a cancel ended keeps the cancel's error with the undo it ran, and is forgotten under it", async () => {
    const cause = new Error("cancelled");
    mocks.cause = cause;

    const { parts } = await drained(ExecutionStatus.Cancelled);

    expect(mocks.kept).toEqual([
      [expect.anything(), STATE, { ended: cause, compensations: undefined }],
    ]);
    expect(mocks.forgotten).toEqual([[parts, STATE, cause]]);
  });

  it("a tree that rests paused keeps its keys: only its lease goes back", async () => {
    const { release } = await drained(ExecutionStatus.Paused);

    expect(mocks.forgotten).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
});
