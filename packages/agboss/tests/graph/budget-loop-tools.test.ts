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
import { argumentsRefusal, closedResult } from "../../src/graph/agent-loop/tool-pii.js";
import { callStepOf, endedCallRecordOf } from "../../src/graph/agent-loop/call-records.js";
import { storedCallOf } from "../../src/graph/agent-loop/stored-call.js";
import { withFiles } from "../../src/files/tool-files.js";
import { keepStopCause } from "../../src/graph/agent-loop/tool-stops.js";
import { StreamEventKind } from "../../src/run/types.js";
import { AgentStream, withAgentStream } from "../../src/run/stream/agent-stream.js";
import { RunStream } from "../../src/run/stream/run-stream.js";

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
vi.mock("../../src/graph/agent-loop/tool-stops.js", async (original) => ({
  ...(await original<typeof import("../../src/graph/agent-loop/tool-stops.js")>()),
  keepStopCause: vi.fn(),
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

const SITE = { agent: "alpha", visit: 2, branch: "run-1" };

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

  it("the visit's stream is told the tool is called, under the step of the model call that asked (#1311)", async () => {
    const { node } = setup();
    const heard = vi.fn();
    const run = newRunContext({ runId: "run-1", signal: undefined });
    const visit = new AgentStream(new RunStream(heard), SITE, false);

    await node({ ...taskOf(), turn: 3 }, withAgentStream({ configurable: { run } }, visit));

    expect(heard).toHaveBeenCalledExactlyOnceWith({
      kind: StreamEventKind.ToolCall,
      tool: "lookup-tool",
      step: { ...SITE, attempt: 3 },
    });
  });

  it("a task of an old checkpoint (no turn) streams its call as the visit's first model call", async () => {
    const { node } = setup();
    const heard = vi.fn();
    const run = newRunContext({ runId: "run-1", signal: undefined });
    const visit = new AgentStream(new RunStream(heard), SITE, false);

    await node(taskOf(), withAgentStream({ configurable: { run } }, visit));

    expect(heard).toHaveBeenCalledExactlyOnceWith({
      kind: StreamEventKind.ToolCall,
      tool: "lookup-tool",
      step: { ...SITE, attempt: 1 },
    });
  });

  it("the run's own stream outside a visit is told nothing: an event has no step without one", async () => {
    const { node } = setup();
    const emit = vi.fn();
    const run = { ...newRunContext({ runId: "run-1", signal: undefined }), stream: { emit } };

    await node(taskOf(), { configurable: { run } });

    expect(emit).not.toHaveBeenCalled();
  });

  it("a run with no stream is told of nothing, and the call goes on", async () => {
    const { node } = setup();

    const out = await node(taskOf(), undefined);

    expect(out.results).toBeDefined();
  });
});

describe("#1366: the spend a call's guardrails carry reaches the loop's usage", () => {
  const closedOf = (usage: readonly UsageRecord[], content = "ok") => ({
    content,
    piiTokens: {},
    piiMasked: {},
    usage,
    isTruncated: false,
  });
  const costsOf = (usage: readonly UsageRecord[] | object | undefined): number[] =>
    listOf<UsageRecord>(usage).map((u) => u.costUsd);

  beforeEach(() => {
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [] });
    vi.mocked(closedResult).mockResolvedValue(closedOf([]));
  });

  it("a call that ran: the check of its arguments, then the closing of its result, after what the tool reported", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [record(0.125, "arguments")] });
    vi.mocked(closedResult).mockResolvedValue(closedOf([record(0.0625, "result")]));
    vi.mocked(runTool).mockImplementation((_tool, _args, context) => {
      context.reportCost(0.5);
      return Promise.resolve({ kind: "ok", value: {} } as never);
    });

    const out = await node(taskOf(), undefined);

    expect(costsOf(out.usage)).toEqual([0.5, 0.125, 0.0625]);
  });

  it("the closing of a result alone is the loop's spend", async () => {
    const { node } = setup();
    vi.mocked(closedResult).mockResolvedValue(closedOf([record(0.0625, "result")]));

    const out = await node(taskOf(), undefined);

    expect(costsOf(out.usage)).toEqual([0.0625]);
  });

  it("the check of the arguments alone is the loop's spend of a call that ran", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [record(0.125, "arguments")] });

    const out = await node(taskOf(), undefined);

    expect(costsOf(out.usage)).toEqual([0.125]);
  });

  it("a call refused by its arguments never runs, and what the check cost is the loop's spend", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({
      content: "Tool error: the call was refused",
      refusal: new Error("blocked"),
      usage: [record(0.125, "arguments")],
    });

    const out = await node(taskOf(), undefined);

    expect(vi.mocked(runTool)).not.toHaveBeenCalled();
    expect(costsOf(out.usage)).toEqual([0.125]);
  });

  it("a call an interceptor stopped: the check of its arguments is the loop's spend", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [record(0.125, "arguments")] });
    vi.mocked(interceptedCall).mockResolvedValue({
      kind: "stopped",
      stop: { interceptor: "gate", reason: "no" },
    } as never);

    const out = await node(taskOf(), undefined);

    expect(costsOf(out.usage)).toEqual([0.125]);
  });

  it("a call an interceptor answered: the check of its arguments and the closing of its reply", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [record(0.125, "arguments")] });
    vi.mocked(closedResult).mockResolvedValue(closedOf([record(0.0625, "reply")], "told"));
    vi.mocked(interceptedCall).mockResolvedValue({ kind: "replied", message: "told" } as never);

    const out = await node(taskOf(), undefined);

    expect(costsOf(out.usage)).toEqual([0.125, 0.0625]);
  });
});

describe("#1366: what a guarded call gives, with what its guardrails spent", () => {
  const closedOf = (changes: Record<string, unknown> = {}) => ({
    content: "ok",
    piiTokens: {},
    piiMasked: {},
    usage: [],
    isTruncated: false,
    ...changes,
  });
  const guardedOf = () =>
    vi.mocked(storedCallOf).mock.calls[0]?.[2] as {
      closed: Record<string, unknown>;
      step: unknown;
      output?: unknown;
      replied?: string;
      stop?: unknown;
    };

  beforeEach(() => {
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [] });
    vi.mocked(closedResult).mockResolvedValue(closedOf());
    vi.mocked(callStepOf).mockReturnValue({ step: true } as never);
  });

  it("a call refused by its arguments: the refusal's text and error, nothing tokenised or truncated, what the check cost", async () => {
    const { node } = setup();
    const error = new Error("blocked");
    vi.mocked(argumentsRefusal).mockResolvedValue({
      content: "Tool error: refused",
      refusal: error,
      usage: [record(0.125, "arguments")],
    });

    await node(taskOf(), undefined);

    expect(guardedOf().closed).toEqual({
      content: "Tool error: refused",
      piiTokens: {},
      piiMasked: {},
      usage: [record(0.125, "arguments")],
      isTruncated: false,
      refusal: error,
    });
    expect(guardedOf().step).toEqual({ step: true });
    expect(vi.mocked(interceptedCall)).not.toHaveBeenCalled();
    expect(vi.mocked(closedResult)).not.toHaveBeenCalled();
  });

  it("a refusal that names no error carries none", async () => {
    const { node } = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({ content: "Tool error: refused", usage: [] });

    await node(taskOf(), undefined);

    expect("refusal" in guardedOf().closed).toBe(false);
  });

  it("the step of a call is made from the task's progress, else from none made yet", async () => {
    const own = setup();
    await own.node(
      { ...taskOf(), progress: { toolLoopIteration: 2, validationAttempts: 1 } },
      undefined,
    );
    const none = setup();
    await none.node(taskOf(), undefined);

    expect(vi.mocked(callStepOf).mock.calls[0]?.[2]).toEqual({
      toolLoopIteration: 2,
      validationAttempts: 1,
    });
    expect(vi.mocked(callStepOf).mock.calls[1]?.[2]).toEqual({
      toolLoopIteration: 0,
      validationAttempts: 0,
    });
    expect(vi.mocked(callStepOf).mock.calls[1]?.[1]).toBe("c1");
    expect(vi.mocked(callStepOf).mock.calls[1]?.[3]).toBe("alpha");
  });

  it("a call an interceptor stopped: the model reads who stopped it and why, nothing of a result is closed, the stop is kept", async () => {
    const { node } = setup();
    const stop = { kind: "blocked", interceptor: "gate", reason: "no" };
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [record(0.125, "arguments")] });
    vi.mocked(interceptedCall).mockImplementation(async (_chain, _tool, _args, _run, keep) => {
      keep(new Error("the interceptor's own"));
      return { kind: "stopped" as const, stop } as never;
    });

    await node(taskOf(), undefined);

    expect(guardedOf().closed).toEqual({
      content: "Tool error: the call was stopped by gate: no",
      piiTokens: {},
      piiMasked: {},
      isTruncated: false,
      usage: [record(0.125, "arguments")],
    });
    expect(guardedOf().stop).toBe(stop);
    expect(vi.mocked(closedResult)).not.toHaveBeenCalled();
    expect(keepStopCause).toHaveBeenCalledWith("run-1", "c1", new Error("the interceptor's own"));
  });

  it("a call an interceptor answered: its message is closed as a result of no tool, under the agent's bound", async () => {
    const { node } = setup();
    vi.mocked(interceptedCall).mockResolvedValue({ kind: "replied", message: "told" } as never);
    vi.mocked(closedResult).mockResolvedValue(closedOf({ content: "told" }));

    await node(taskOf(), undefined);

    expect(vi.mocked(closedResult).mock.calls[0]?.[1]).toBeUndefined();
    expect(vi.mocked(closedResult).mock.calls[0]?.[2]).toEqual({ kind: "ok", value: "told" });
    expect(guardedOf().replied).toBe("told");
    expect(guardedOf().output).toBeUndefined();
  });

  it("a call that ran: its output is closed with its tool, under the tool's bound else the agent's", async () => {
    const { node } = setup({ tool: toolOf({ maxResultSize: 77 }) });

    await node(taskOf(), undefined);

    const [, tool, output, bound] = vi.mocked(closedResult).mock.calls[0] ?? [];
    expect(tool).toMatchObject({ name: "lookup-tool" });
    expect(output).toEqual({ kind: "ok", value: { ok: true } });
    expect(bound).toBe(77);
    expect(guardedOf().output).toEqual({ kind: "ok", value: { ok: true } });
    expect(guardedOf().replied).toBeUndefined();
    expect(guardedOf().stop).toBeUndefined();
  });

  it("the interceptors run the tool with the arguments, and an agent's bound is the default of its tools", async () => {
    const { node } = setup();

    await node(taskOf(), undefined);

    expect(vi.mocked(interceptedCall).mock.calls[0]?.[2]).toEqual({ q: 1 });
    expect(vi.mocked(closedResult).mock.calls[0]?.[3]).toBeUndefined();
  });
});

describe("#1366: what an ended task stores", () => {
  const closedOf = (changes: Record<string, unknown> = {}) => ({
    content: "ok",
    piiTokens: {},
    piiMasked: {},
    usage: [],
    isTruncated: false,
    ...changes,
  });

  beforeEach(() => {
    vi.mocked(argumentsRefusal).mockResolvedValue({ usage: [] });
    vi.mocked(closedResult).mockResolvedValue(closedOf());
  });

  it("the transcriptions, tokens and decisions the files made are the task's, with the closed result's tokens and masks", async () => {
    const { node } = setup();
    vi.mocked(closedResult).mockResolvedValue(
      closedOf({ piiTokens: { a: "1" }, piiMasked: { m: "x" } }),
    );
    vi.mocked(withFiles).mockImplementationOnce(((
      _d: unknown,
      _t: unknown,
      _task: unknown,
      guarded: object,
    ) =>
      Promise.resolve({
        ...guarded,
        transcripts: { f: "text" },
        tokens: { b: "2" },
        decisions: [{ decision: true }],
      })) as never);

    const out = await node(taskOf(), undefined);

    expect(out).toMatchObject({
      fileTranscripts: { f: "text" },
      piiTokens: { a: "1", b: "2" },
      piiMasked: { m: "x" },
      guardrailDecisions: [{ decision: true }],
      results: { c1: "stored" },
      callRecords: { c1: { record: true } },
    });
  });

  it("a call whose files made nothing adds nothing", async () => {
    const { node } = setup();

    const out = await node(taskOf(), undefined);

    expect(out.fileTranscripts).toEqual({});
    expect(out.guardrailDecisions).toEqual([]);
    expect(out.piiTokens).toEqual({});
  });

  it("arguments its tool's input check refuses are one more validation attempt; valid ones are none", async () => {
    const bad = setup({ tool: toolOf({ input: { safeParse: () => ({ success: false }) } }) });
    const good = setup();

    expect((await bad.node(taskOf(), undefined)).invalidArguments).toBe(1);
    expect((await good.node(taskOf(), undefined)).invalidArguments).toBe(0);
  });

  it("the call's record is made from the call and the times it started and ended", async () => {
    const { node } = setup();

    await node(taskOf(), undefined);

    const [call, times] = vi.mocked(endedCallRecordOf).mock.calls[0] ?? [];
    expect(call).toMatchObject({ args: { q: 1 }, isResultTruncated: false });
    expect(times?.startedAt).toBeInstanceOf(Date);
    expect(times?.endedAt).toBeInstanceOf(Date);
  });
});
