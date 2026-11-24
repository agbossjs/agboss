import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-run shard) — how a run's spend reaches the ledger and its turn in the run's own passes, each rule
 * on its own over fakes: the new run records what its graph spends as it is made, keeps it on its running record
 * and on the failure's, a continued pass does not record again the spend before it, and a failure's record
 * carries all of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { executionGraphOf } from "../../src/flow/runtime/build.js";
import { continueRun } from "../../src/run/continue-run.js";
import { finishRun } from "../../src/run/finish.js";
import { memoryBeforeRun } from "../../src/run/compact-before-run.js";
import { executeAgent, runOpenedAgent } from "../../src/run/run-agent.js";
import {
  continuedExecutionBudgets,
  inStartFrame,
  openExecutionBudgets,
} from "../../src/run/run-budgets.js";
import { openThread } from "../../src/run/thread.js";
import { streamConfig } from "../../src/run/stream-config.js";

vi.mock("../../src/flow/runtime/build.js", () => ({ executionGraphOf: vi.fn() }));
vi.mock("../../src/run/finish.js", () => ({ finishRun: vi.fn() }));
vi.mock("../../src/run/compact-before-run.js", () => ({ memoryBeforeRun: vi.fn() }));
vi.mock("../../src/run/stream-config.js", () => ({ streamConfig: vi.fn() }));
vi.mock("../../src/run/versions.js", () => ({
  executionVersions: () => ({ promptVersion: "p1", modelVersion: "m1", configVersion: "c1" }),
}));
vi.mock("../../src/flow/runtime/start-input.js", () => ({
  startNamed: vi.fn((_graph: unknown, name: string) => ({ name })),
  validStartInput: vi.fn((_node: unknown, payload: unknown) => payload),
}));
vi.mock("../../src/run/thread.js", () => ({ openThread: vi.fn() }));
vi.mock("../../src/run/run-budgets.js", async (original) => ({
  ...(await original<typeof import("../../src/run/run-budgets.js")>()),
  openExecutionBudgets: vi.fn(),
  continuedExecutionBudgets: vi.fn(),
  inStartFrame: vi.fn(() => "frame"),
}));

const record = (costUsd: number, caller = "agent:a"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

async function* statesOf(...states: readonly unknown[]): AsyncGenerator {
  await Promise.resolve();
  for (const state of states) yield state;
}

/** What the fakes hold for one pass. */
const setup = () => {
  const meter = { record: vi.fn(() => Promise.resolve()), budgetUsd: () => 2 };
  const append = vi.fn((turn: Record<string, unknown>) =>
    Promise.resolve({ id: `turn-${String(append.mock.calls.length)}`, ...turn }),
  );
  const complete = vi.fn(() => Promise.resolve());
  const deps = {
    config: { name: "bundle", version: "1.0.0" },
    graph: {},
    turns: { append, complete },
    executionIds: { newExecutionId: vi.fn(() => Promise.resolve("run-1")) },
    clock: { now: () => new Date("2026-11-21T10:00:00.000Z") },
  };
  const graph = { stream: vi.fn() };
  vi.mocked(executionGraphOf).mockReturnValue(graph as never);
  vi.mocked(openExecutionBudgets).mockResolvedValue({ meter, records: [{ budget: "b" }] } as never);
  vi.mocked(continuedExecutionBudgets).mockResolvedValue({ meter, records: [] } as never);
  vi.mocked(openThread).mockResolvedValue({ threadId: "thread-1" });
  vi.mocked(streamConfig).mockReturnValue({ callbacks: ["cb"] } as never);
  vi.mocked(memoryBeforeRun).mockResolvedValue({
    history: "h",
    memory: "m",
    usage: [record(0.125, "compaction:c")],
    compacted: [{ compaction: "c" }],
  } as never);
  vi.mocked(finishRun).mockResolvedValue({ status: "finished" } as never);
  return { deps: deps as never, meter, append, complete, graph, raw: deps };
};

const startedWith = { start: "chat", input: { text: "hi" } };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: a new run records what it spends", () => {
  const compaction = record(0.125, "compaction:c");
  const a = record(0.5);
  const b = record(0.25, "agent:b");

  it("records each new usage record of the graph's states once, never what compaction already recorded", async () => {
    const { deps, meter, graph } = setup();
    graph.stream.mockResolvedValue(
      statesOf({ usage: [compaction, a] }, { usage: [compaction, a, b] }),
    );

    const result = await executeAgent(startedWith, deps);

    expect(result).toEqual({ status: "finished" });
    expect(meter.record.mock.calls).toEqual([[[a]], [[b]]]);
    const [context, state, turnId] = vi.mocked(finishRun).mock.calls[0] ?? [];
    expect(context).toMatchObject({
      runId: "run-1",
      budgetUsd: 2,
      recorded: [a, b],
      callbacks: ["cb"],
      compacted: [{ compaction: "c" }],
      base: {
        runId: "run-1",
        threadId: "thread-1",
        tenantId: "default",
        workflow: "bundle",
        task: 'start chat: {"text":"hi"}',
        replayOf: null,
        promptVersion: "p1",
      },
    });
    expect(state).toEqual({ usage: [compaction, a, b] });
    expect(turnId).toBe("turn-1");
  });

  it("starts the graph from the budgets, the thread's memory and what its compaction spent", async () => {
    const { deps, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, deps, { replayOf: "run-0" });

    expect(graph.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "chat",
        startInput: { text: "hi" },
        piiKey: null,
        startedAt: "2026-11-21T10:00:00.000Z",
        budgetUsd: 2,
        budgets: [{ budget: "b" }],
        history: "h",
        memory: "m",
        usage: [compaction],
        runId: "run-1",
      }),
      { callbacks: ["cb"] },
    );
    expect(vi.mocked(finishRun).mock.calls[0]?.[0]).toMatchObject({ base: { replayOf: "run-0" } });
  });

  it("keeps a running record while the tree moves: no route, no cost", async () => {
    const { deps, graph, append } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, deps);

    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toEqual({
      runId: "run-1",
      threadId: "thread-1",
      tenantId: "default",
      workflow: "bundle",
      task: 'start chat: {"text":"hi"}',
      replayOf: null,
      promptVersion: "p1",
      modelVersion: "m1",
      configVersion: "c1",
      replyWith: "",
      status: "running",
      stopReason: "",
      route: [],
      steps: [],
      costUsd: usd(0),
    });
  });

  it("a new thread is created once the budgets pass, and has nothing to read; one it continues must exist", async () => {
    const { deps, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));
    vi.mocked(openThread).mockResolvedValue({ threadId: "t-9" });

    await executeAgent({ ...startedWith, threadId: "t-9" }, deps);

    expect(openThread).toHaveBeenCalledOnce();
    expect(openThread).toHaveBeenCalledWith(deps, "default", "t-9");
    expect(memoryBeforeRun).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ isNewThread: false, threadId: "t-9", budgetUsd: 2 }),
    );

    vi.mocked(openThread).mockClear();
    vi.mocked(openThread).mockResolvedValue({ threadId: "thread-1" });
    await executeAgent(startedWith, deps);

    expect(openThread).toHaveBeenCalledOnce();
    expect(openThread).toHaveBeenCalledWith(deps, "default", undefined);
    expect(memoryBeforeRun).toHaveBeenLastCalledWith(
      deps,
      expect.objectContaining({ isNewThread: true, tenantId: "default", threadId: "thread-1" }),
    );
  });

  it("the compaction's spend goes through the run's recorder: on the meter, and on the list the finish reads", async () => {
    const { deps, graph, meter } = setup();
    graph.stream.mockResolvedValue(statesOf({ usage: [compaction] }));
    vi.mocked(memoryBeforeRun).mockImplementation(
      (_deps, before) =>
        before.record([compaction]).then(() => ({
          history: "",
          memory: "",
          usage: [compaction],
          compacted: [],
        })) as never,
    );

    await executeAgent(startedWith, deps);

    expect(meter.record).toHaveBeenCalledWith([compaction]);
    expect(vi.mocked(finishRun).mock.calls[0]?.[0]).toMatchObject({ recorded: [compaction] });
  });

  it("opens the budgets before the thread: one exhausted leaves no thread", async () => {
    const { deps } = setup();
    vi.mocked(openExecutionBudgets).mockRejectedValue(new Error("budget"));

    await expect(executeAgent(startedWith, deps)).rejects.toThrow("budget");

    expect(openThread).not.toHaveBeenCalled();
    expect(vi.mocked(openExecutionBudgets).mock.calls[0]?.[1]).toMatchObject({
      executionId: "run-1",
      start: "chat",
    });
  });

  it("the budgets the app opened are the run's own: none opened again", async () => {
    const { deps, graph, meter } = setup();
    graph.stream.mockResolvedValue(statesOf({ usage: [a] }));
    const opened = { meter, records: [{ budget: "app" }] } as never;

    await runOpenedAgent(startedWith, deps, {}, opened);

    expect(openExecutionBudgets).not.toHaveBeenCalled();
    expect(executionGraphOf).toHaveBeenCalledWith(deps, { budgets: meter });
    expect(meter.record).toHaveBeenCalledWith([a]);
    expect(graph.stream.mock.calls[0]?.[0]).toMatchObject({ budgets: [{ budget: "app" }] });
  });

  it("an execution id the caller gave is used, else the application's ids are asked", async () => {
    const { deps, raw, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, deps, { executionId: "given" });

    expect(raw.executionIds.newExecutionId).not.toHaveBeenCalled();
    expect(vi.mocked(finishRun).mock.calls[0]?.[0]).toMatchObject({ runId: "given" });

    vi.mocked(finishRun).mockClear();
    await executeAgent(startedWith, deps);

    expect(raw.executionIds.newExecutionId).toHaveBeenCalledWith("default");
    expect(vi.mocked(finishRun).mock.calls[0]?.[0]).toMatchObject({ runId: "run-1" });
  });

  it("without an application's ids a run's id is minted, never missing", async () => {
    const { raw, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, { ...raw, executionIds: undefined } as never);

    const { runId } = vi.mocked(finishRun).mock.calls[0]?.[0] ?? { runId: "" };
    expect(runId).not.toBe("");
    expect(runId).not.toBe("run-1");
  });

  it("an execution of its own key gets a key of its own only when the instance has none", async () => {
    const { raw, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, { ...raw, pii: { isInstanceKey: true } } as never);
    await executeAgent(startedWith, { ...raw, pii: { isInstanceKey: false } } as never);

    expect(typeof graph.stream.mock.calls[0]?.[0].piiKey).toBe("string");
    expect(graph.stream.mock.calls[1]?.[0].piiKey).toBeNull();
  });

  it("the start frame is the execution's: its id, thread and start, for the compaction and the budgets", async () => {
    const { deps, graph } = setup();
    graph.stream.mockImplementation(() => Promise.resolve(statesOf({ usage: [] })));

    await executeAgent(startedWith, deps);

    expect(vi.mocked(inStartFrame).mock.calls[0]?.[1]).toMatchObject({
      executionId: "run-1",
      threadId: "thread-1",
      start: "chat",
    });
    expect(memoryBeforeRun).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ inFrame: "frame" }),
    );
  });

  it("a failed run completes its running record with the spend recorded so far", async () => {
    const { deps, graph, complete } = setup();
    graph.stream.mockResolvedValue(
      (async function* () {
        await Promise.resolve();
        yield { usage: [compaction, a] };
        throw new Error("boom");
      })(),
    );

    const failure = await executeAgent(startedWith, deps).catch((e: unknown) => e);

    expect((failure as Error).message).toBe("boom");
    expect(complete).toHaveBeenCalledWith("turn-1", {
      replyWith: "",
      status: "failed",
      stopReason: "boom",
      route: [],
      steps: [],
      costUsd: usd(0.5),
    });
  });

  it("a failure before the record exists appends it as failed, and is not unwound", async () => {
    const { raw, append, complete } = setup();
    vi.mocked(memoryBeforeRun).mockRejectedValue(new Error("compaction"));
    const rootUnwind = vi.fn((error: unknown) => Promise.resolve(error));

    const failure = await executeAgent(startedWith, {
      ...raw,
      compensation: { rootUnwind },
    } as never).catch((e: unknown) => e);

    expect((failure as Error).message).toBe("compaction");
    expect(rootUnwind).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      stopReason: "compaction",
      runId: "run-1",
      costUsd: usd(0),
    });
  });

  it("a failure after the record exists is unwound by the root's undo, then completed", async () => {
    const { raw, graph, complete } = setup();
    graph.stream.mockRejectedValue(new Error("boom"));
    const rootUnwind = vi.fn(() => Promise.resolve(new Error("undone")));

    const failure = await executeAgent(startedWith, {
      ...raw,
      compensation: { rootUnwind },
    } as never).catch((e: unknown) => e);

    expect((failure as Error).message).toBe("undone");
    expect(rootUnwind).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({ status: "failed", stopReason: "undone" }),
    );
  });

  it("a run stopped by its signal fails as cancelled", async () => {
    const { deps, graph } = setup();
    graph.stream.mockRejectedValue(new Error("aborted"));
    const controller = new AbortController();
    controller.abort();

    const failure = await executeAgent(startedWith, deps, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ExecutionCancelledError);
  });
});

describe("#1366: a continued pass does not record the spend before it", () => {
  const run = {
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    turnId: "turn-1",
    start: "chat",
    startInput: { text: "hi" },
    budgetUsd: 2,
    budgets: [{ budget: "b" }],
    spent: [record(1)],
    takenPauseIds: new Set(["p"]),
  } as never;

  it("finishes with the spend of the passes before and this pass's own, and the pauses it took", async () => {
    const { deps, meter } = setup();
    const pass = vi.fn(
      async (
        _graph: unknown,
        _streaming: unknown,
        recorded: (records: readonly UsageRecord[]) => Promise<void>,
      ) => {
        await recorded([record(0.5, "agent:c")]);
        return { usage: [] };
      },
    );

    const result = await continueRun(run, deps, {}, pass as never);

    expect(result).toEqual({ status: "finished" });
    expect(continuedExecutionBudgets).toHaveBeenCalledWith(
      deps,
      [{ budget: "b" }],
      [record(1)],
      undefined,
    );
    expect(meter.record).toHaveBeenCalledWith([record(0.5, "agent:c")]);
    const [context, state, turnId] = vi.mocked(finishRun).mock.calls[0] ?? [];
    expect(context).toMatchObject({
      runId: "run-1",
      budgetUsd: 2,
      recorded: [record(1), record(0.5, "agent:c")],
      takenPauseIds: new Set(["p"]),
      callbacks: ["cb"],
      base: {
        runId: "run-1",
        threadId: "thread-1",
        tenantId: "tenant-1",
        workflow: "bundle",
        task: 'start chat: {"text":"hi"}',
        replayOf: null,
        promptVersion: "p1",
      },
    });
    expect(state).toEqual({ usage: [] });
    expect(turnId).toBe("turn-1");
  });

  it("a failure completes the record with the cost of all the spend: before the pass and in it", async () => {
    const { deps, complete } = setup();
    const pass = async (
      _graph: unknown,
      _streaming: unknown,
      recorded: (records: readonly UsageRecord[]) => Promise<void>,
    ): Promise<never> => {
      await recorded([record(0.5, "agent:c")]);
      throw new Error("boom");
    };

    const failure = await continueRun(run, deps, {}, pass as never).catch((e: unknown) => e);

    expect((failure as Error).message).toBe("boom");
    expect(complete).toHaveBeenCalledWith("turn-1", {
      replyWith: "",
      status: "failed",
      stopReason: "boom",
      route: [],
      steps: [],
      costUsd: usd(1.5),
    });
  });

  it("a run stopped by its signal fails as cancelled", async () => {
    const { deps, complete } = setup();
    const controller = new AbortController();
    controller.abort();
    const pass = (): Promise<never> => Promise.reject(new Error("aborted"));

    const failure = await continueRun(run, deps, { signal: controller.signal }, pass).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ExecutionCancelledError);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("the failure is unwound by the root's undo first when the deps have one", async () => {
    const { deps, complete } = setup();
    const rootUnwind = vi.fn(() => Promise.resolve(new Error("undone")));
    const withUndo = { ...(deps as object), compensation: { rootUnwind } } as never;
    const pass = (): Promise<never> => Promise.reject(new Error("boom"));

    const failure = await continueRun(run, withUndo, {}, pass).catch((e: unknown) => e);

    expect((failure as Error).message).toBe("undone");
    expect(complete).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({ stopReason: "undone" }),
    );
  });
});
