import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-memory shard) — what a compaction spends and stores, each rule on its own over fakes: every model
 * call recorded at once under `compaction:<name>`, the summary asked again shorter when it was cut, the cost the
 * summary is stored with, the masking spend, and the budget left for the next compaction.
 */
import { AIMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionError } from "../../src/compaction/errors.js";
import { CompactionStrategy } from "../../src/compaction/compaction.decorator.js";
import { TurnLimit } from "../../src/config/types.js";
import {
  CURRENT_SUMMARY_HEADING,
  EARLIER_TURNS_HEADING,
  TURNS_TO_ADD_HEADING,
  TURNS_TO_COMPACT_HEADING,
} from "../../src/prompts/compaction.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { summaryOf, compactDue, compactWithModel } from "../../src/run/compaction.js";
import { compactWithHandler } from "../../src/run/custom-compaction.js";
import { storedCompaction } from "../../src/run/compaction-parts.js";
import { SHORTER_SUMMARY_REQUEST } from "../../src/prompts/compaction.js";

vi.mock("../../src/run/custom-compaction.js", () => ({ compactWithHandler: vi.fn() }));
vi.mock("../../src/run/compaction-parts.js", async (original) => ({
  ...(await original<typeof import("../../src/run/compaction-parts.js")>()),
  storedCompaction: vi.fn(),
}));

/** A model's answer: its text, its reported cost, and whether it was cut at `max_tokens`. */
const answer = (text: string, costUsd: number, isCut = false): AIMessage =>
  new AIMessage({
    content: text,
    response_metadata: { usage: { cost: costUsd }, ...(isCut ? { finish_reason: "length" } : {}) },
  });

const compaction = (changes: Record<string, unknown> = {}) =>
  ({
    name: "notes",
    strategy: CompactionStrategy.SummaryQueue,
    window: 1,
    turnsBetweenCompactions: 2,
    summaryQueueLength: 3,
    summaryMaxTokens: 400,
    prompt: "Summarise.",
    ...changes,
  }) as never;

const turnOf = (id: string, text = id) => ({
  id,
  task: `start chat: "${text}"`,
  replyWith: `finish done: "${text}"`,
  status: "answered",
});

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** The run, its deps and the model; every call of the model answers the next of `answers`. */
const setup = (
  answers: readonly AIMessage[],
  options: { due?: number; budgetLeft?: number } = {},
) => {
  const invoke = vi.fn();
  for (const one of answers) invoke.mockResolvedValueOnce(one);
  const calls: string[] = [];
  const recorded = vi.fn((records: readonly UsageRecord[]) => {
    calls.push(`record:${records.map((r) => r.caller).join(",")}`);
    return Promise.resolve();
  });
  const turns = {
    uncovered: vi.fn(() =>
      Promise.resolve(["t1", "t2", "t3", "t4"].slice(0, options.due ?? 3).map((id) => turnOf(id))),
    ),
    latestSummaries: vi.fn(() => Promise.resolve([])),
    before: vi.fn(() => Promise.resolve([])),
    summaryCount: vi.fn(() => Promise.resolve(1)),
    addSummary: vi.fn(() => {
      calls.push("add");
      return Promise.resolve();
    }),
    turnNumber: vi.fn((_t: string, _th: string, id: string) =>
      Promise.resolve(Number(id.slice(1))),
    ),
  };
  const binding = { model: { invoke }, settings: { model: "cheap" } };
  const deps = {
    config: { name: "bundle" },
    turns,
    registry: { compactions: new Map([["notes", binding]]) },
  };
  const run = {
    tenantId: "tenant-1",
    threadId: "thread-1",
    budgetLeftUsd: options.budgetLeft ?? 2,
    callbacks: ["cb"],
    tokens: {},
    inFrame: vi.fn(),
    record: recorded,
  };
  return { deps: deps as never, run: run as never, invoke, recorded, turns, calls, binding };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(storedCompaction).mockImplementation(async (...args) => {
    const real = await vi.importActual<typeof import("../../src/run/compaction-parts.js")>(
      "../../src/run/compaction-parts.js",
    );
    return real.storedCompaction(...args);
  });
});

describe("#1366: the summary's model call", () => {
  it("is recorded at once under `compaction:<name>`, and a summary that fits is the first answer", async () => {
    const { run, invoke, recorded, binding } = setup([answer("the summary", 0.25)]);

    const out = await summaryOf(binding as never, compaction(), "input", run);

    expect(out.text).toBe("the summary");
    expect(out.usage).toEqual([
      expect.objectContaining({ caller: "compaction:notes", costUsd: usd(0.25), model: "cheap" }),
    ]);
    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith(out.usage);
    const [messages, options] = invoke.mock.calls[0] ?? [];
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["Summarise.", "input"]);
    expect(options).toEqual({ callbacks: ["cb"], runName: "compaction:notes" });
  });

  it("a summary cut at its limit is asked once more, shorter: both calls recorded, both spent", async () => {
    const { run, invoke, recorded, binding } = setup([
      answer("cut", 0.25, true),
      answer("short", 0.125),
    ]);

    const out = await summaryOf(binding as never, compaction(), "input", run);

    expect(out.text).toBe("short");
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25, 0.125]);
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0][1].text).toBe(`input\n\n${SHORTER_SUMMARY_REQUEST}`);
  });

  it("cut again, it is a CompactionError that names the limit — and both calls were recorded", async () => {
    const { run, recorded, binding } = setup([
      answer("cut", 0.25, true),
      answer("cut", 0.125, true),
    ]);

    const failure = await summaryOf(binding as never, compaction(), "input", run).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(CompactionError);
    expect((failure as Error).message).toBe(
      "notes: the summary did not fit in summaryMaxTokens 400, also when asked to be shorter",
    );
    expect(failure).toMatchObject({ compaction: "notes", summaryMaxTokens: 400 });
    expect(recorded).toHaveBeenCalledTimes(2);
  });

  it("a failed call is a CompactionError with the cause; one that is already a CompactionError passes as it is", async () => {
    const { run, invoke, binding } = setup([]);
    const cause = new Error("down");
    invoke.mockRejectedValueOnce(cause);
    const own = new CompactionError({ message: "own", compaction: "notes", summaryMaxTokens: 400 });
    invoke.mockRejectedValueOnce(own);

    const wrapped = await summaryOf(binding as never, compaction(), "i", run).catch(
      (e: unknown) => e,
    );
    const passed = await summaryOf(binding as never, compaction(), "i", run).catch(
      (e: unknown) => e,
    );

    expect(wrapped).toBeInstanceOf(CompactionError);
    expect((wrapped as Error).message).toBe("notes: the summary's model call failed");
    expect((wrapped as Error).cause).toBe(cause);
    expect(wrapped).toMatchObject({ compaction: "notes", summaryMaxTokens: 400 });
    expect(passed).toBe(own);
  });
});

describe("#1366: the compactions due before an execution", () => {
  it("summarises the turns older than the window, stores the summary with its cost and says what it did", async () => {
    const { deps, run, turns, calls } = setup([answer(" the summary ", 0.25)]);
    const plan = { compactions: [compaction()] } as never;

    const out = await compactDue(deps, plan, run);

    expect(turns.addSummary).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      threadId: "thread-1",
      bundle: "bundle",
      compaction: "notes",
      fromTurnId: "t1",
      toTurnId: "t2",
      turns: 2,
      text: "the summary",
      costUsd: usd(0.25),
    });
    expect(out.compacted).toEqual([
      { compaction: "notes", fromTurn: 1, toTurn: 2, summaries: 2, summaryQueueLength: 3 },
    ]);
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25]);
    expect(calls).toEqual(["record:compaction:notes", "add"]);
  });

  it("the summaries it counts never pass the queue's length", async () => {
    const { deps, run, turns } = setup([answer("s", 0.25)]);
    turns.summaryCount.mockResolvedValue(5);

    const out = await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(out.compacted[0]?.summaries).toBe(3);
  });

  it("a thread with fewer turns due than `turnsBetweenCompactions` is left as it is", async () => {
    const { deps, run, invoke } = setup([], { due: 2 });

    const out = await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(out).toEqual({ usage: [], compacted: [] });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a compaction with no model bound spends nothing", async () => {
    const { deps, run } = setup([]);
    (deps as { registry: { compactions: Map<string, unknown> } }).registry.compactions.clear();

    const out = await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(out).toEqual({ usage: [], compacted: [] });
  });

  it("a model that wrote nothing is a CompactionError: nothing is stored", async () => {
    const { deps, run, turns } = setup([answer("   ", 0.25)]);

    const failure = await compactDue(deps, { compactions: [compaction()] } as never, run).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(CompactionError);
    expect((failure as Error).message).toBe("notes: the model wrote an empty summary");
    expect(failure).toMatchObject({ compaction: "notes", summaryMaxTokens: 400 });
    expect(turns.addSummary).not.toHaveBeenCalled();
  });

  it("stops while the budget lasts: a compaction with nothing left is skipped, its spend counted for the next", async () => {
    const { deps, run, invoke } = setup([answer("one", 1), answer("two", 1)], { budgetLeft: 1 });
    const second = compaction({ name: "notes" });
    const plan = { compactions: [compaction(), second, second] } as never;

    const out = await compactDue(deps, plan, run);

    expect(invoke).toHaveBeenCalledOnce();
    expect(out.usage.map((u) => u.costUsd)).toEqual([1]);
    expect(out.compacted).toHaveLength(1);
  });

  it("a budget already spent compacts nothing", async () => {
    const { deps, run, invoke } = setup([answer("one", 1)], { budgetLeft: 0 });

    const out = await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(invoke).not.toHaveBeenCalled();
    expect(out).toEqual({ usage: [], compacted: [] });
  });

  it("every compaction of the plan runs in order, and what each spent and did is the outcome's", async () => {
    const { deps, run, invoke } = setup([answer("one", 0.25), answer("two", 0.125)]);
    const plan = { compactions: [compaction(), compaction()] } as never;

    const out = await compactDue(deps, plan, run);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25, 0.125]);
    expect(out.compacted).toHaveLength(2);
  });

  it("a custom compaction is run by its handler, and its spend and work are the outcome's", async () => {
    const { deps, run, turns } = setup([]);
    const done = {
      compaction: "notes",
      fromTurn: 1,
      toTurn: 2,
      summaries: 1,
      summaryQueueLength: 3,
    };
    vi.mocked(compactWithHandler).mockResolvedValue({ usage: [record(0.5)], compacted: done });
    const custom = compaction({ strategy: CompactionStrategy.Custom });

    const out = await compactDue(deps, { compactions: [custom] } as never, run);

    expect(compactWithHandler).toHaveBeenCalledOnce();
    expect(out).toEqual({ usage: [record(0.5)], compacted: [done] });
    expect(turns.addSummary).not.toHaveBeenCalled();
  });

  it("a window of every turn leaves nothing due", async () => {
    const { deps, run, invoke } = setup([answer("one", 1)]);

    const out = await compactDue(
      deps,
      { compactions: [compaction({ window: "all" })] } as never,
      run,
    );

    expect(out).toEqual({ usage: [], compacted: [] });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a single summary is rewritten from the current one and covers the thread from its first turn", async () => {
    const { deps, run, turns, invoke } = setup([answer("new", 0.25)]);
    turns.latestSummaries.mockResolvedValue([
      { text: "current", fromTurnId: "t0", turns: 4 },
    ] as never);
    const single = compaction({ strategy: CompactionStrategy.SingleSummary });

    await compactDue(deps, { compactions: [single] } as never, run);

    expect(turns.latestSummaries).toHaveBeenCalledWith("tenant-1", "thread-1", "notes", 1);
    expect(turns.addSummary).toHaveBeenCalledWith(
      expect.objectContaining({ fromTurnId: "t0", toTurnId: "t2", turns: 6, text: "new" }),
    );
    expect(invoke.mock.calls[0]?.[0][1].text).toContain("current");
  });
});

describe("#1366: a compaction that stored nothing", () => {
  it("has spent what it spent and reports no work: the outcome has no `compacted` key at all", async () => {
    const { deps, run } = setup([answer("the summary", 0.25)]);
    vi.mocked(storedCompaction).mockResolvedValue(undefined);
    const due = [turnOf("t1"), turnOf("t2")] as never;

    const out = await compactWithModel(deps, compaction(), run, due);

    expect(out).toStrictEqual({ usage: [expect.objectContaining({ costUsd: usd(0.25) })] });
  });
});

describe("#1366: which turns are due, and what the compaction's model reads", () => {
  const inputOf = (invoke: { mock: { calls: unknown[][] } }): string =>
    (invoke.mock.calls[0]?.[0] as { text: string }[])[1]?.text ?? "";

  it("a window that keeps every turn leaves none due: nothing is read or asked", async () => {
    const { deps, run, invoke, turns } = setup([], { due: 4 });
    const uncovered = await turns.uncovered();
    const filter = vi.fn(
      (...args: Parameters<typeof uncovered.filter>) =>
        Array.prototype.filter.apply(uncovered, args) as typeof uncovered,
    );
    turns.uncovered.mockResolvedValue(Object.assign([...uncovered], { filter }));
    const plan = { compactions: [compaction({ window: TurnLimit.ALL })] } as never;

    const out = await compactDue(deps, plan, run);

    expect(out).toEqual({ usage: [], compacted: [] });
    expect(filter).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(turns.addSummary).not.toHaveBeenCalled();
  });

  it("a queue's model reads the turns before the first due one as context, then the due ones", async () => {
    const { deps, run, invoke, turns } = setup([answer("s", 0.25)]);
    turns.before.mockResolvedValue([turnOf("t0", "earlier")] as never);

    await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(turns.before).toHaveBeenCalledWith("tenant-1", "thread-1", "t1", 2);
    expect(inputOf(invoke)).toBe(
      `${EARLIER_TURNS_HEADING}\nstart chat: "earlier"\nfinish done: "earlier"\n\n${TURNS_TO_COMPACT_HEADING}\nstart chat: "t1"\nfinish done: "t1"\n\nstart chat: "t2"\nfinish done: "t2"`,
    );
  });

  it("a queue with no turns before the due ones reads only those", async () => {
    const { deps, run, invoke } = setup([answer("s", 0.25)]);

    await compactDue(deps, { compactions: [compaction()] } as never, run);

    expect(inputOf(invoke).startsWith(TURNS_TO_COMPACT_HEADING)).toBe(true);
  });

  it("a single summary's model reads the summary so far and the turns to add, and is told it is the one it continues", async () => {
    const { deps, run, invoke, turns } = setup([answer("s", 0.25)]);
    const current = { id: "s1", text: "so far", fromTurnId: "t0", toTurnId: "t0" };
    turns.latestSummaries.mockResolvedValue([current] as never);
    const single = compaction({ strategy: CompactionStrategy.SingleSummary });

    await compactDue(deps, { compactions: [single] } as never, run);

    expect(turns.latestSummaries).toHaveBeenCalledWith("tenant-1", "thread-1", "notes", 1);
    expect(turns.before).not.toHaveBeenCalled();
    expect(inputOf(invoke)).toBe(
      `${CURRENT_SUMMARY_HEADING}\nso far\n\n${TURNS_TO_ADD_HEADING}\nstart chat: "t1"\nfinish done: "t1"\n\nstart chat: "t2"\nfinish done: "t2"`,
    );
  });

  it("a single summary with none yet says so", async () => {
    const { deps, run, invoke } = setup([answer("s", 0.25)]);
    const single = compaction({ strategy: CompactionStrategy.SingleSummary });

    await compactDue(deps, { compactions: [single] } as never, run);

    expect(inputOf(invoke).startsWith(`${CURRENT_SUMMARY_HEADING}\n(none yet)\n\n`)).toBe(true);
  });

  it("due turns that are none are asked of no earlier ones: the model reads the heading only", async () => {
    const { deps, run, turns, invoke } = setup([answer("s", 0.25)]);

    await compactWithModel(deps, compaction(), run, []);

    expect(turns.before).not.toHaveBeenCalled();
    expect(inputOf(invoke)).toBe(`${TURNS_TO_COMPACT_HEADING}\n`);
  });
});
