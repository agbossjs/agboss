/**
 * #1366 (ledger-memory shard) — the spend of a thread's memory, each rule on its own over fakes: the strategies'
 * update after a finished turn (#844), the compactions before a new execution (#120), the masking and the store
 * of a compaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryPlanOf } from "../../src/compaction/plan.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { compactDue } from "../../src/run/compaction.js";
import { memoryBeforeRun, updateMemoryAfter } from "../../src/run/memory.js";
import { threadMemoryOf } from "../../src/run/thread.js";

vi.mock("../../src/compaction/plan.js", () => ({ memoryPlanOf: vi.fn() }));
vi.mock("../../src/run/compaction.js", () => ({ compactDue: vi.fn() }));
vi.mock("../../src/run/thread.js", async (original) => ({
  ...(await original<typeof import("../../src/run/thread.js")>()),
  threadMemoryOf: vi.fn(),
}));

const record = (costUsd: number, caller = "memory"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
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
    budgetLeftUsd: 2,
    callbacks: [],
    record: vi.fn(),
    inFrame: vi.fn(),
  });
  const run = (isNewThread: boolean) => runOf(isNewThread) as never;
  const deps = { config: { name: "c" }, compactions: { name: "k" } } as never;

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
      compacted: [{ compaction: "c1" }],
    } as never);
    const given = runOf(false);

    const out = await memoryBeforeRun(deps, given as never);

    expect(compactDue).toHaveBeenCalledWith(deps, plan, { ...given, tokens: {} });
    expect(out).toEqual({
      history: ["h"],
      memory: {},
      usage: [record(0.5)],
      compacted: [{ compaction: "c1" }],
    });
  });
});

describe("#1366: memory after a finished turn", () => {
  const history = { start: "s", finish: "f" };
  const strategy = (usage: readonly UsageRecord[] | undefined) => ({
    updateMemory: vi.fn(() => Promise.resolve(usage === undefined ? undefined : { usage })),
  });
  const ctxOf = (strategies: readonly object[]) => {
    const recorded = vi.fn(() => Promise.resolve());
    const memory = new Map(strategies.map((one, i) => [`agent-${String(i)}`, one]));
    return {
      ctx: {
        base: { tenantId: "tenant-1", threadId: "thread-1" },
        runId: "run-1",
        budgetUsd: 2,
        record: recorded,
        deps: { memory },
      } as never,
      recorded,
    };
  };

  it("gives each strategy the turn and the budget left after the spend so far and the strategies before it", async () => {
    const first = strategy([record(0.5)]);
    const second = strategy([record(0.25)]);
    const { ctx } = ctxOf([first, second]);

    await updateMemoryAfter(ctx, [record(1)], history);

    const turn = {
      tenantId: "tenant-1",
      threadId: "thread-1",
      executionId: "run-1",
      turn: history,
    };
    expect(first.updateMemory).toHaveBeenCalledWith({ ...turn, budgetLeftUsd: 1 });
    expect(second.updateMemory).toHaveBeenCalledWith({ ...turn, budgetLeftUsd: 0.5 });
  });

  it("records what the strategies spent, once and together, and returns it", async () => {
    const { ctx, recorded } = ctxOf([strategy([record(0.5)]), strategy([record(0.25)])]);

    const out = await updateMemoryAfter(ctx, [], history);

    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith([record(0.5), record(0.25)]);
    expect(out).toEqual({ usage: [record(0.5), record(0.25)] });
  });

  it("records nothing when nothing was spent; a strategy that spends nothing or has no update is skipped", async () => {
    const { ctx, recorded } = ctxOf([strategy(undefined), strategy([]), {}]);

    const out = await updateMemoryAfter(ctx, [], history);

    expect(recorded).not.toHaveBeenCalled();
    expect(out).toEqual({ usage: [] });
  });

  it("a strategy shared by two agents updates once", async () => {
    const shared = strategy([record(0.5)]);
    const { ctx } = ctxOf([shared, shared]);

    const out = await updateMemoryAfter(ctx, [], history);

    expect(shared.updateMemory).toHaveBeenCalledOnce();
    expect(out.usage).toEqual([record(0.5)]);
  });

  it("an application with no agent memory has nothing to update", async () => {
    const recorded = vi.fn();
    const ctx = {
      base: { tenantId: "t", threadId: "th" },
      runId: "r",
      budgetUsd: 1,
      record: recorded,
      deps: {},
    } as never;

    expect(await updateMemoryAfter(ctx, [], history)).toEqual({ usage: [] });
    expect(recorded).not.toHaveBeenCalled();
  });
});
