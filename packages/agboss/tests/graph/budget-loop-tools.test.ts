/**
 * #1366 (budget-loop shard) — the budget rules of one tool call of an agent's loop, each on its own over fakes: the
 * cost a tool reports and the usage it reports through its frame are counted the moment they are reported
 * (#338) under the tool's caller, and what the budgets give back is the loop's spend; the call's signal is
 * the budgets' exhausted one too and is released when the call ends, whatever way; a cancelled run starts none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { newRunContext } from "../../src/core/run-context.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { makeToolNode } from "../../src/graph/agent-loop/tools-node.js";
import { runTool } from "../../src/graph/agent-loop/run-tool.js";
import { inToolCallFrame } from "../../src/flow/context/frame.js";
import { interceptedCall } from "../../src/graph/agent-loop/tool-interception.js";

vi.mock("../../src/graph/agent-loop/run-tool.js", () => ({ runTool: vi.fn() }));
vi.mock("../../src/graph/agent-loop/tool-pii.js", () => ({
  argumentsRefusal: vi.fn(() => Promise.resolve({ usage: [] })),
  readingAgent: vi.fn((_deps: unknown, _task: unknown, work: () => unknown) => work()),
  closedResult: vi.fn(() =>
    Promise.resolve({ content: "ok", piiTokens: {}, piiMasked: {}, usage: [], isTruncated: false }),
  ),
}));
vi.mock("../../src/graph/agent-loop/tool-interception.js", () => ({
  interceptedCall: vi.fn(),
  interceptorsOf: vi.fn(() => []),
  questionResultOf: vi.fn((_tool: unknown, _task: unknown, work: () => unknown) => work()),
}));
vi.mock("../../src/graph/agent-loop/call-records.js", () => ({
  callStepOf: vi.fn(() => ({ step: true })),
  endedCallRecordOf: vi.fn(() => ({ record: true })),
}));
vi.mock("../../src/graph/agent-loop/stored-call.js", () => ({
  storedCallOf: vi.fn(() => "stored"),
}));
vi.mock("../../src/files/tool-files.js", () => ({
  withFiles: vi.fn((_deps: unknown, _tool: unknown, _task: unknown, guarded: unknown) =>
    Promise.resolve(guarded),
  ),
}));
vi.mock("../../src/flow/observers/execution-event.js", () => ({
  reportNodeEvent: vi.fn((work: (base: object) => unknown) =>
    Promise.resolve(work({ base: true })),
  ),
}));
vi.mock("../../src/flow/runtime/tool-keys.js", () => ({ toolRecordOf: vi.fn(() => ({})) }));
vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  inLoopFrame: vi.fn((_progress: unknown, work: () => unknown) => work()),
  inToolCallFrame: vi.fn(
    (_callId: unknown, _services: unknown, work: () => unknown, _signal: unknown) => work(),
  ),
}));

/** A list an update gives: a plain one or an overwrite of one. */
const listOf = <T>(value: readonly T[] | object | undefined): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const toolOf = (changes: Record<string, unknown> = {}) => ({
  name: "lookup-tool",
  timeout: 30_000,
  input: { safeParse: () => ({ success: true }) },
  ...changes,
});

const taskOf = () => ({ callId: "c1", tool: "lookup-tool", args: { q: 1 }, runId: "run-1" });

function setup(
  options: { tool?: object | undefined; isExhausted?: boolean; observer?: object } = {},
) {
  const exhausted = new AbortController();
  if (options.isExhausted === true) exhausted.abort();
  const tally = vi.fn((records: readonly UsageRecord[]) =>
    records.map((r) => ({ ...r, tallied: true })),
  );
  const deps = {
    agent: { name: "alpha", tools: [], maxResultSize: undefined },
    budgets: { exhausted: exhausted.signal, tally, remaining: () => 5, deadline: undefined },
    observer: options.observer,
  };
  vi.mocked(interceptedCall).mockImplementation(async (_chain, _tool, _args, run) => ({
    kind: "ran" as const,
    output: await run(),
  }));
  vi.mocked(runTool).mockResolvedValue({ kind: "ok", value: { ok: true } } as never);
  const tools = "tool" in options ? options.tool : toolOf();
  const withTool = { ...deps, agent: { ...deps.agent, tools: tools === undefined ? [] : [tools] } };
  return { node: makeToolNode(withTool as never), tally, exhausted };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: the spend of a tool call is counted when it is reported", () => {
  it("a cost the tool reports is a record of the tool's caller, tallied at once, and its tallied form is the loop's spend", async () => {
    const { node, tally } = setup();
    vi.mocked(runTool).mockImplementation((_tool, _args, context) => {
      context.reportCost(0.5);
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    const out = await node(taskOf(), undefined);

    expect(tally).toHaveBeenCalledOnce();
    expect(tally.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ caller: "tool:lookup-tool", costUsd: 0.5 }),
    ]);
    expect(out.usage).toEqual([expect.objectContaining({ costUsd: 0.5, tallied: true })]);
  });

  it("a tool with a cost caller of its own bills it", async () => {
    const { node, tally } = setup({ tool: toolOf({ costCaller: "rag:docs" }) });
    vi.mocked(runTool).mockImplementation((_tool, _args, context) => {
      context.reportCost(0.5);
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    await node(taskOf(), undefined);

    expect(tally.mock.calls[0]?.[0]?.[0]?.caller).toBe("rag:docs");
  });

  it("a usage record a service reports in the call's frame is billed to the tool's caller, tallied at once", async () => {
    const { node, tally } = setup();
    vi.mocked(runTool).mockImplementation(() => {
      const services = vi.mocked(inToolCallFrame).mock.calls[0]?.[1] as {
        reportUsage: (record: UsageRecord) => void;
      };
      services.reportUsage(record(0.25, "service"));
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    const out = await node(taskOf(), undefined);

    expect(tally).toHaveBeenCalledWith([{ ...record(0.25), caller: "tool:lookup-tool" }]);
    expect(out.usage).toEqual([expect.objectContaining({ costUsd: 0.25, tallied: true })]);
  });

  it("several reports are each tallied, in order, and all of them are the loop's spend", async () => {
    const { node, tally } = setup();
    vi.mocked(runTool).mockImplementation((_tool, _args, context) => {
      context.reportCost(0.5);
      context.reportCost(0.25);
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    const out = await node(taskOf(), undefined);

    expect(tally).toHaveBeenCalledTimes(2);
    expect(listOf<UsageRecord>(out.usage).map((u) => u.costUsd)).toEqual([0.5, 0.25]);
  });

  it("a call that reports nothing spends nothing", async () => {
    const { node, tally } = setup();

    const out = await node(taskOf(), undefined);

    expect(tally).not.toHaveBeenCalled();
    expect(out.usage).toEqual([]);
  });

  it("the call's frame carries the call id, the usage report and the mesh services", async () => {
    const { node } = setup();

    await node(taskOf(), undefined);

    const [callId, services] = vi.mocked(inToolCallFrame).mock.calls[0] ?? [];
    expect(callId).toBe("c1");
    expect(services).toMatchObject({
      reportUsage: expect.any(Function),
      meshCall: expect.objectContaining({ tool: "lookup-tool" }),
    });
    const mesh = (services as { meshCall: { remainingBudget: () => number | undefined } }).meshCall;
    expect(mesh.remainingBudget()).toBe(5);
  });
});

describe("#1366: the call's signal", () => {
  it("is aborted by the budgets' exhausted signal and by the run's", async () => {
    const { node, exhausted } = setup();
    const run = newRunContext({ runId: "run-1", signal: undefined });
    await node(taskOf(), { configurable: { run } });

    const [, , , signal] = vi.mocked(inToolCallFrame).mock.calls[0] ?? [];
    expect(signal?.aborted).toBe(false);
    exhausted.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("the tool's context carries the same signal and the run's clock", async () => {
    const { node } = setup();
    let seen: { signal: AbortSignal; clock: unknown } | undefined;
    vi.mocked(runTool).mockImplementation((_tool, _args, context) => {
      seen = context as never;
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    await node(taskOf(), undefined);

    expect(seen?.signal).toBe(vi.mocked(inToolCallFrame).mock.calls[0]?.[3]);
    expect(seen?.clock).toBeDefined();
  });

  it("is released when the call ends, whatever way", async () => {
    const ok = setup();
    const bad = setup();
    vi.mocked(interceptedCall).mockRejectedValueOnce(new Error("broke"));

    await bad.node(taskOf() as never, undefined).catch(() => undefined);
    await ok.node(taskOf(), undefined);

    // a released timer leaves no pending timeout: the node returned and a second call is as fresh
    expect(vi.mocked(interceptedCall)).toHaveBeenCalledTimes(2);
  });
});

describe("#1366: a call that never starts", () => {
  it("a tool the agent has not is no call: nothing is spent", async () => {
    const { node, tally } = setup({ tool: undefined });

    const out = await node(taskOf(), undefined);

    expect(out).toEqual({});
    expect(tally).not.toHaveBeenCalled();
    expect(inToolCallFrame).not.toHaveBeenCalled();
  });

  it("a cancelled run starts no call", async () => {
    const { node } = setup();
    const run = newRunContext({ runId: "run-1", signal: AbortSignal.abort() });

    await expect(node(taskOf() as never, { configurable: { run } })).rejects.toBeInstanceOf(
      ExecutionCancelledError,
    );

    expect(inToolCallFrame).not.toHaveBeenCalled();
  });
});

describe("#1366: what the call tells", () => {
  it("the observer hears of the start: the tool, the agent and the arguments", async () => {
    const onToolStart = vi.fn();
    const { node } = setup({ observer: { onToolStart, onToolEnd: vi.fn() } });

    await node(taskOf(), undefined);

    expect(onToolStart).toHaveBeenCalledWith({
      base: true,
      toolName: "lookup-tool",
      agentName: "alpha",
      arguments: { q: 1 },
    });
  });

  it("a stream of the run is told the tool is called", async () => {
    const { node } = setup();
    const emit = vi.fn();
    const run = { ...newRunContext({ runId: "run-1", signal: undefined }), stream: { emit } };

    await node(taskOf(), { configurable: { run } });

    expect(emit).toHaveBeenCalledWith({ kind: "toolCall", tool: "lookup-tool" });
  });

  it("a run with no stream is told of nothing, and the call goes on", async () => {
    const { node } = setup();

    const out = await node(taskOf(), undefined);

    expect(out.results).toBeDefined();
  });
});
