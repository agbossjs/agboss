/**
 * #1366 (budget-loop shard) — the record a tool call leaves and the frame it runs in, each on its own over fakes: the
 * record of a call that ran, was refused its arguments, was answered by an interceptor or was stopped carries exactly
 * what that outcome has (and the remote spend of its mesh calls), and a call with a loop position runs in that frame.
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
import { toolMeshCallOf } from "../../src/graph/agent-loop/mesh-call.js";
import { inLoopFrame } from "../../src/flow/context/frame.js";

vi.mock("../../src/graph/agent-loop/mesh-call.js", () => ({ toolMeshCallOf: vi.fn() }));
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

const TOOL = {
  name: "lookup-tool",
  timeout: 30_000,
  input: { safeParse: () => ({ success: true }) },
};

const taskOf = (changes: Record<string, unknown> = {}) => ({
  callId: "c1",
  tool: "lookup-tool",
  args: { q: 1 },
  runId: "run-1",
  ...changes,
});

function setup(remote?: object) {
  vi.mocked(toolMeshCallOf).mockReturnValue({ services: {}, remote: () => remote } as never);
  const deps = {
    agent: { name: "alpha", tools: [TOOL], maxResultSize: undefined },
    budgets: { exhausted: new AbortController().signal, tally: vi.fn((r: unknown) => r) },
    observer: undefined,
  };
  vi.mocked(runTool).mockResolvedValue({ kind: "ok", value: { ok: true } } as never);
  vi.mocked(interceptedCall).mockImplementation(async (_chain, _tool, args, run) => ({
    kind: "ran" as const,
    output: await run(args),
  }));
  return makeToolNode(deps as never);
}

const recordedCall = () => vi.mocked(endedCallRecordOf).mock.calls[0]?.[0];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: the record of a tool call", () => {
  it("a call that ran carries its tool, step, arguments, truncation and output, and nothing else", async () => {
    const node = setup();

    await node(taskOf(), undefined);

    expect(recordedCall()).toStrictEqual({
      tool: TOOL,
      step: { step: true },
      args: { q: 1 },
      isResultTruncated: false,
      output: { kind: "ok", value: { ok: true } },
    });
  });

  it("a truncated result and the remote spend of the tool's mesh calls are in it", async () => {
    const remote = { calls: 1 };
    const node = setup(remote);
    vi.mocked(closedResult).mockResolvedValue({
      content: "ok",
      piiTokens: {},
      piiMasked: {},
      usage: [],
      isTruncated: true,
    });

    await node(taskOf(), undefined);

    expect(recordedCall()).toMatchObject({ isResultTruncated: true, remote });
  });

  it("a call whose arguments were refused carries the refusal, and no output", async () => {
    const node = setup();
    vi.mocked(argumentsRefusal).mockResolvedValue({
      content: "refused",
      refusal: { kind: "pii" },
      usage: [],
    } as never);

    await node(taskOf(), undefined);

    expect(recordedCall()).toStrictEqual({
      tool: TOOL,
      step: { step: true },
      args: { q: 1 },
      isResultTruncated: false,
      refusal: { kind: "pii" },
    });
    expect(runTool).not.toHaveBeenCalled();
  });

  it("a call an interceptor answered carries the reply, and no output", async () => {
    const node = setup();
    vi.mocked(interceptedCall).mockResolvedValue({ kind: "replied", message: "cached" } as never);

    await node(taskOf(), undefined);

    expect(recordedCall()).toStrictEqual({
      tool: TOOL,
      step: { step: true },
      args: { q: 1 },
      isResultTruncated: false,
      replied: "cached",
    });
  });

  it("a call an interceptor stopped carries the stop, and its content is said to the model", async () => {
    const node = setup();
    const stop = { kind: "denied", reason: "no" };
    vi.mocked(interceptedCall).mockResolvedValue({ kind: "stopped", stop } as never);

    await node(taskOf(), undefined);

    expect(recordedCall()).toStrictEqual({
      tool: TOOL,
      step: { step: true },
      args: { q: 1 },
      isResultTruncated: false,
      stop,
    });
  });
});

describe("#1366: the frame a tool call runs in", () => {
  it("a call that has a position in the loop runs in the loop's frame at it, one that has none runs as it is", async () => {
    const node = setup();
    const progress = { toolLoopIteration: 2, validationAttempts: 1 };

    await node(taskOf({ progress }), undefined);
    await node(taskOf(), undefined);

    expect(inLoopFrame).toHaveBeenCalledOnce();
    expect(vi.mocked(inLoopFrame).mock.calls[0]?.[0]).toBe(progress);
    expect(callStepOf).toHaveBeenNthCalledWith(1, expect.anything(), "c1", progress, "alpha");
    expect(callStepOf).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "c1",
      { toolLoopIteration: 0, validationAttempts: 0 },
      "alpha",
    );
  });
});
