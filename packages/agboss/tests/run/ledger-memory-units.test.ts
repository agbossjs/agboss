import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-memory shard) — the spend of a thread's memory, each rule on its own over fakes: the strategies'
 * update after a finished turn (#844), the compactions before a new execution (#120), the masking and the store
 * of a compaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryPlanOf } from "../../src/memory/plan.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { compactDue } from "../../src/run/compaction.js";
import { memoryBeforeRun } from "../../src/run/compact-before-run.js";
import { threadMemoryOf } from "../../src/run/thread.js";

vi.mock("../../src/memory/plan.js", () => ({ memoryPlanOf: vi.fn() }));
vi.mock("../../src/run/compaction.js", () => ({ compactDue: vi.fn() }));
vi.mock("../../src/run/thread.js", async (original) => ({
  ...(await original<typeof import("../../src/run/thread.js")>()),
  threadMemoryOf: vi.fn(),
}));

const record = (costUsd: number, caller = "memory"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: memory before a new execution", () => {
  const runOf = (isNewThread: boolean): Record<string, unknown> => ({
    tenantId: "tenant-1",
    threadId: "thread-1",
    isNewThread,
    budgetUsd: 2,
    callbacks: [],
    record: vi.fn(),
    inFrame: vi.fn(),
  });
  const run = (isNewThread: boolean) => runOf(isNewThread) as never;
  const deps = { config: { name: "c" }, memories: { name: "k" } } as never;

  it("a new thread has nothing to read and nothing to compact", async () => {
    const out = await memoryBeforeRun(deps, run(true));

    expect(out).toEqual({ history: [], memory: {}, usage: [], compacted: [] });
    expect(memoryPlanOf).not.toHaveBeenCalled();
    expect(threadMemoryOf).not.toHaveBeenCalled();
  });

  it("a thread whose plan compacts nothing is only read", async () => {
    vi.mocked(memoryPlanOf).mockReturnValue({ compactions: [] } as never);
    vi.mocked(threadMemoryOf).mockResolvedValue({ history: ["h"], memory: { a: 1 } } as never);

    const out = await memoryBeforeRun(deps, run(false));

    expect(out).toEqual({ history: ["h"], memory: { a: 1 }, usage: [], compacted: [] });
    expect(memoryPlanOf).toHaveBeenCalledWith({ name: "c" }, { name: "k" });
    expect(threadMemoryOf).toHaveBeenCalledWith(deps, {
      tenantId: "tenant-1",
      threadId: "thread-1",
    });
    expect(compactDue).not.toHaveBeenCalled();
  });

  it("the compactions due run first, with the run's budget and record, and what they spent is the run's", async () => {
    const plan = { compactions: [{ name: "c1" }] };
    vi.mocked(memoryPlanOf).mockReturnValue(plan as never);
    vi.mocked(threadMemoryOf).mockResolvedValue({ history: ["h"], memory: {} } as never);
    vi.mocked(compactDue).mockResolvedValue({
      usage: [record(0.5)],
      compacted: [{ memory: "c1" }],
    } as never);
    const given = runOf(false);

    const out = await memoryBeforeRun(deps, given as never);

    expect(compactDue).toHaveBeenCalledWith(deps, plan, {
      ...given,
      budgetLeftUsd: usd(2),
      tokens: {},
    });
    expect(out).toEqual({
      history: ["h"],
      memory: {},
      usage: [record(0.5)],
      compacted: [{ memory: "c1" }],
    });
  });
});
