import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-run shard) — what finishing a run writes, each rule on its own over fakes: the turn's cost and its
 * status, the spend of the loops a pause leaves going to the ledger at once and once, the strategies' spend of a
 * finished turn, and the end a graph without a finish is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGBossError } from "../../src/core/errors.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { CostReport, CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { finishLine } from "../../src/flow/runtime/history.js";
import { endOf, finishRun, outcomeOf } from "../../src/run/finish.js";
import { isWaiting, pausedLoopsOf } from "../../src/run/paused.js";
import { openPausesOf, waitingPausesOf } from "../../src/run/waiting-pauses.js";

vi.mock("../../src/run/paused.js", async (original) => ({
  ...(await original<typeof import("../../src/run/paused.js")>()),
  isWaiting: vi.fn(),
  pausedLoopsOf: vi.fn(),
}));
vi.mock("../../src/run/waiting-pauses.js", async (original) => ({
  ...(await original<typeof import("../../src/run/waiting-pauses.js")>()),
  openPausesOf: vi.fn(),
  waitingPausesOf: vi.fn(),
}));

const record = (costUsd: number, caller = "agent:a"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    start: "chat",
    startInput: { text: "hi" },
    startedVersion: "",
    path: ["chat", "alpha"],
    usage: [record(0.5)],
    finish: "done",
    output: { text: "ok" },
    scope: { s: 1 },
    outdatedValues: { o: 1 },
    lastError: { e: 1 },
    launches: [{ l: 1 }],
    children: [{ c: 1 }],
    handledErrors: [{ h: 1 }],
    compensations: [{ k: 1 }],
    toolCalls: [{ t: 1 }],
    stepRecords: [{ r: 1 }],
    contexts: {},
    ...changes,
  }) as never;

const setup = (options: { paused?: boolean; compacted?: unknown; pause?: boolean } = {}) => {
  const append = vi.fn(() => Promise.resolve({ id: "turn-new" }));
  const complete = vi.fn(() => Promise.resolve());
  const completeUnlessInterrupted = vi.fn(() => Promise.resolve(true));
  const recorded = vi.fn(() => Promise.resolve());
  const pauses = { name: "pauses" };
  const checkpointer = { name: "saver" };
  const graph = { name: "graph" };
  const ctx = {
    deps: {
      config: { version: "9.9.9" },
      graph: { nodes: new Map() }, // no finish node declared: the stored output stays as it is (#1301)
      turns: { append, complete, completeUnlessInterrupted },
      ...(options.pause === false ? {} : { pause: { pauses, checkpointer } }),
    },
    graph,
    base: { runId: "run-1", tenantId: "tenant-1", threadId: "thread-1", task: "the task" },
    runId: "run-1",
    budgetUsd: 2,
    record: recorded,
    recorded: [] as UsageRecord[],
    takenPauseIds: new Set(["taken"]),
    callbacks: [],
    compacted: options.compacted,
  };
  vi.mocked(isWaiting).mockResolvedValue(options.paused === true);
  return {
    ctx: ctx as never,
    raw: ctx,
    append,
    complete,
    completeUnlessInterrupted,
    recorded,
    pauses,
    checkpointer,
    graph,
  };
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: a finished run's turn", () => {
  it("is answered with its finish line, its path and the cost of its spend", async () => {
    const { ctx, append } = setup();

    const out = await finishRun(ctx, stateOf());

    expect(append).toHaveBeenCalledWith({
      runId: "run-1",
      tenantId: "tenant-1",
      threadId: "thread-1",
      task: "the task",
      replyWith: finishLine("done", { text: "ok" }),
      status: "answered",
      stopReason: "",
      route: ["chat", "alpha"],
      steps: [],
      costUsd: usd(0.5),
    });
    expect(out).toEqual({
      status: ExecutionStatus.Finished,
      start: "chat",
      startInput: { text: "hi" },
      path: ["chat", "alpha"],
      budgetUsd: 2,
      cost: CostReport.fromUsage([record(0.5)]),
      threadId: "thread-1",
      tenantId: "tenant-1",
      turnId: "turn-new",
      runId: "run-1",
      startedVersion: "9.9.9",
      data: {
        scope: { s: 1 },
        outdatedValues: { o: 1 },
        lastError: { e: 1 },
        launches: [{ l: 1 }],
        children: [{ c: 1 }],
        handledErrors: [{ h: 1 }],
        compensations: [{ k: 1 }],
        toolCalls: [{ t: 1 }],
        steps: [{ r: 1 }],
      },
      finish: "done",
      output: { text: "ok" },
      pending: [],
    });
    expect(Object.keys(out)).not.toContain("compacted");
    expect(Object.keys(out)).not.toContain("traceUrl");
  });

  it("is completed, not appended, when it had a record while it ran", async () => {
    const { ctx, append, complete, completeUnlessInterrupted } = setup();

    const out = await finishRun(ctx, stateOf(), "turn-running");

    expect(append).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled(); // a finish is written only while no stop or cancel is marked (#1341b)
    expect(completeUnlessInterrupted).toHaveBeenCalledWith(
      "turn-running",
      expect.objectContaining({ status: "answered", costUsd: usd(0.5) }),
    );
    expect(out.turnId).toBe("turn-running");
  });

  it("a finish a stop or cancel mark refuses is not recorded: the run ends as the mark", async () => {
    const { ctx, completeUnlessInterrupted } = setup();
    completeUnlessInterrupted.mockResolvedValueOnce(false);

    await expect(finishRun(ctx, stateOf(), "turn-running")).rejects.toBeInstanceOf(AGBossError);
  });

  it("keeps the version it started on, else the application's", async () => {
    const { ctx } = setup();

    const kept = await finishRun(ctx, stateOf({ startedVersion: "1.2.3" }));

    expect(kept.startedVersion).toBe("1.2.3");
  });

  it("says what the compactions did, only when they did", async () => {
    const compacted = [
      { memory: "c", fromTurn: 1, toTurn: 2, summaries: 1, summaryQueueLength: 3 },
    ];

    const did = await finishRun(setup({ compacted }).ctx, stateOf());
    const none = await finishRun(setup({ compacted: [] }).ctx, stateOf());

    expect(did.compacted).toEqual(compacted);
    expect(Object.keys(none)).not.toContain("compacted");
  });

  it("carries where its request came from and where its trace is (#1324f)", async () => {
    const { ctx, raw } = setup();
    Object.assign(raw.deps, {
      tracing: { traceUrl: (ctx: { threadId: string }) => `https://trace/${ctx.threadId}` },
    });
    const state = stateOf({ contexts: { mesh: { trusted: { origin: { application: "peer" } } } } });

    const out = await finishRun(ctx, state);

    expect(out.data).toMatchObject({ origin: { application: "peer" } });
    expect(out.traceUrl).toBe("https://trace/thread-1");
  });

  it("a request that came from no trusted peer, or through no mesh, carries no origin", async () => {
    const untrusted = setup();
    const unmeshed = setup();

    const first = await finishRun(untrusted.ctx, stateOf({ contexts: { mesh: {} } }));
    const second = await finishRun(unmeshed.ctx, stateOf({ contexts: {} }));

    expect(Object.keys(first.data)).not.toContain("origin");
    expect(Object.keys(second.data)).not.toContain("origin");
  });

  it("is refused when its graph stopped at no finish and waits for nothing: never recorded as answered", async () => {
    const { ctx, append } = setup();

    const failure = await finishRun(ctx, stateOf({ finish: "" })).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AGBossError);
    expect((failure as Error).message).toBe(
      "execution run-1 stopped at no finish node and waits for nothing: its graph did not end — a framework bug; the run is failed, not recorded as answered",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("without a pause seam never asks whether it waits", async () => {
    const { ctx } = setup({ pause: false });

    await finishRun(ctx, stateOf());

    expect(isWaiting).not.toHaveBeenCalled();
  });
});

describe("#1366: a paused run", () => {
  const paused = (usage: readonly UsageRecord[]) => {
    const made = setup({ paused: true });
    const isOpen = vi.fn();
    const pending = [{ step: "alpha-agent", pauseId: "p1" }];
    vi.mocked(waitingPausesOf).mockResolvedValue(pending as never);
    vi.mocked(openPausesOf).mockResolvedValue(isOpen);
    vi.mocked(pausedLoopsOf).mockResolvedValue([{ usage }] as never);
    return { ...made, isOpen, pending };
  };

  it("writes the spend of its paused loops to the ledger now, once: not what is recorded already", async () => {
    const made = paused([record(0.25, "loop"), record(0.5)]);
    made.raw.recorded.push(record(0.5));

    await finishRun(made.ctx, stateOf({ finish: "" }));

    expect(made.recorded).toHaveBeenCalledOnce();
    expect(made.recorded).toHaveBeenCalledWith([record(0.25, "loop"), record(0.5)]);
  });

  it("reads its waiting pauses, the open ones it did not take, and the loops they wait in", async () => {
    const made = paused([]);

    await finishRun(made.ctx, stateOf({ finish: "" }));

    const tree = { tenantId: "tenant-1", runId: "run-1" };
    expect(isWaiting).toHaveBeenCalledWith(made.graph, "run-1");
    expect(waitingPausesOf).toHaveBeenCalledWith(made.graph, made.pauses, tree);
    expect(openPausesOf).toHaveBeenCalledWith(made.pauses, tree, { taken: new Set(["taken"]) });
    expect(pausedLoopsOf).toHaveBeenCalledWith(made.graph, made.checkpointer, "run-1", made.isOpen);
  });

  it("is paused with its spend so far, waits where its pause is and has no finish; no memory is updated", async () => {
    const made = paused([record(0.25, "loop")]);

    const out = await finishRun(made.ctx, stateOf({ finish: "" }), "turn-running");

    expect(made.complete).toHaveBeenCalledWith("turn-running", {
      replyWith: "",
      status: "paused",
      stopReason: "waiting for approval",
      route: ["chat", "alpha"],
      steps: [],
      costUsd: usd(0.75),
    });
    expect(out.status).toBe(ExecutionStatus.Paused);
    expect(out.path).toEqual(["chat", "alpha", "alpha-agent"]);
    expect(out.pending).toEqual(made.pending);
    expect(out.cost).toEqual(CostReport.fromUsage([record(0.5), record(0.25, "loop")]));
    expect(Object.keys(out)).not.toContain("finish");
    expect(Object.keys(out)).not.toContain("output");
  });

  it("a paused run that has a finish set still reports none and an empty reply", async () => {
    const made = paused([]);

    const out = await finishRun(made.ctx, stateOf(), "tt");

    expect(made.complete).toHaveBeenCalledWith(
      "tt",
      expect.objectContaining({ replyWith: "", status: "paused" }),
    );
    expect(Object.keys(out)).not.toContain("finish");
  });

  it("with no pending pause its path is the visited one", async () => {
    const made = paused([]);
    vi.mocked(waitingPausesOf).mockResolvedValue([]);

    const out = await finishRun(made.ctx, stateOf({ finish: "" }), "t");

    expect(out.path).toEqual(["chat", "alpha"]);
  });

  it("a run that waits for nothing is not paused: its spend is the state's", async () => {
    const made = setup({ paused: false });

    await finishRun(made.ctx, stateOf());

    expect(made.recorded).not.toHaveBeenCalled();
    expect(waitingPausesOf).not.toHaveBeenCalled();
  });
});

describe("#1366: the turn's outcome and the end a result reports", () => {
  it("a run that ended is answered with its finish line and the cost of its spend", async () => {
    expect(await outcomeOf(stateOf(), [record(0.5), record(0.25)], false)).toEqual({
      replyWith: finishLine("done", { text: "ok" }),
      status: "answered",
      stopReason: "",
      route: ["chat", "alpha"],
      steps: [],
      costUsd: usd(0.75),
    });
  });

  it("a paused run has no reply and says what it waits for", async () => {
    expect(await outcomeOf(stateOf(), [record(0.5)], true)).toEqual({
      replyWith: "",
      status: "paused",
      stopReason: "waiting for approval",
      route: ["chat", "alpha"],
      steps: [],
      costUsd: usd(0.5),
    });
  });

  it("a run with no finish has no reply, whatever its output", async () => {
    const out = await outcomeOf(stateOf({ finish: "" }), [], false);

    expect(out.replyWith).toBe("");
    expect(out.status).toBe("answered");
    expect(out.stopReason).toBe("");
  });

  it("a finish and its output are reported for a run that ended, never for a paused one or one with no finish", () => {
    expect(endOf(stateOf(), false)).toEqual({ finish: "done", output: { text: "ok" } });
    expect(endOf(stateOf(), true)).toEqual({});
    expect(endOf(stateOf({ finish: "" }), false)).toEqual({});
  });
});
