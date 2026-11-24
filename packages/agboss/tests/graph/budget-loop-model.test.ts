import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-loop shard) — the budget rules around one model call of an agent's loop, each on its own over fakes:
 * the exhausted signal on the call in flight, the check before the call (after a stop by an exhausted budget first),
 * the agent's `modelCalls` and `toolCalls` limits with the spend they carry, the spend counted at once and
 * the check after the call that asks for tools.
 */
import { StreamDiscardReason } from "../../src/run/types.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { newRunContext } from "../../src/core/run-context.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { makeModelNode } from "../../src/graph/agent-loop/model-node.js";
import {
  loopPoliciesOf,
  maskedRequest,
  outgoingMove,
} from "../../src/graph/agent-loop/model-pii.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { LimitExceededError } from "../../src/graph/limits.js";
import { attemptOf } from "../../src/graph/agent-loop/answer-stream.js";
import { reportNodeEvent } from "../../src/flow/observers/execution-event.js";

vi.mock("../../src/graph/agent-loop/answer-stream.js", async (original) => ({
  ...(await original<typeof import("../../src/graph/agent-loop/answer-stream.js")>()),
  attemptOf: vi.fn(),
}));
vi.mock("../../src/flow/observers/execution-event.js", () => ({
  reportNodeEvent: vi.fn((work: (base: object) => unknown) =>
    Promise.resolve(work({ base: true })),
  ),
}));
vi.mock("../../src/flow/runtime/answer-tools.js", () => ({ toolBindingOf: vi.fn(() => ({})) }));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({
  loopPoliciesOf: vi.fn(),
  maskedRequest: vi.fn(),
  outgoingMove: vi.fn(),
}));

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    usage: [record(1, "before"), record(0.5, "loop")],
    from: { usage: 1 },
    flowPath: ["a", "b"],
    modelCalls: 0,
    toolCalls: 0,
    piiTokens: {},
    ...changes,
  }) as never;

/** The model's answer: a text, or tool calls, with the cost the provider reported. */
const answerOf = (cost: number, calls: { id: string; name: string }[] = []): AIMessage =>
  new AIMessage({
    content: "answer",
    tool_calls: calls.map((call) => ({ ...call, args: {}, type: "tool_call" as const })),
    response_metadata: { usage: { cost } },
  });

function setup(options: { modelCalls?: number; toolCalls?: number; isExhausted?: boolean } = {}) {
  const exhausted = new AbortController();
  if (options.isExhausted === true) exhausted.abort();
  const order: string[] = [];
  const budgets = {
    exhausted: exhausted.signal,
    check: vi.fn((..._args: unknown[]) => {
      order.push("check");
    }),
    tally: vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) => {
      order.push("tally");
      return records;
    }),
  };
  const invoke = vi.fn((_messages: unknown, _call: unknown) => {
    order.push("call");
    return Promise.resolve(answerOf(0.25));
  });
  const deps = {
    agent: {
      name: "alpha",
      tools: [],
      answerTools: { tools: [] },
      limits: { modelCalls: options.modelCalls ?? 3, toolCalls: options.toolCalls ?? 2 },
      binding: { model: { invoke, bindTools: () => ({ invoke }) }, settings: { model: "m" } },
    },
    budgets,
  };
  vi.mocked(maskedRequest).mockResolvedValue({
    messages: [new SystemMessage("rules"), new HumanMessage("hi")],
    tokens: {},
    cache: {},
    blocked: [],
    usage: [record(0.125, "mask")],
  });
  vi.mocked(loopPoliciesOf).mockReturnValue(undefined);
  const attempt = { discard: vi.fn(), end: vi.fn() };
  vi.mocked(attemptOf).mockReturnValue(attempt as never);
  vi.mocked(outgoingMove).mockImplementation((move) =>
    Promise.resolve({ kind: "move" as const, move, usage: [record(0.0625, "check")] }),
  );
  return { node: makeModelNode(deps as never), budgets, invoke, order, exhausted, attempt, deps };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(reportNodeEvent).mockImplementation((work: (base: never) => unknown) =>
    Promise.resolve(work({ base: true } as never)).then(() => undefined),
  );
});

describe("#1366: the check before a model call", () => {
  it("checks the budgets with the state's usage, the flow path and what the loop spent", async () => {
    const { node, budgets } = setup();

    await node(stateOf(), undefined);

    expect(budgets.check).toHaveBeenCalledOnce();
    expect(budgets.check).toHaveBeenCalledWith(
      [record(1, "before"), record(0.5, "loop")],
      ["a", "b"],
      [record(0.5, "loop")],
    );
  });

  it("an exhausted budget refuses the call: nothing is asked of the model", async () => {
    const { node, budgets, invoke } = setup();
    budgets.check.mockImplementation(() => {
      throw new Error("exhausted");
    });

    await expect(node(stateOf(), undefined)).rejects.toThrow("exhausted");

    expect(invoke).not.toHaveBeenCalled();
    expect(maskedRequest).not.toHaveBeenCalled();
  });

  it("a stop by an exhausted budget names the budget before a cancel of the run does", async () => {
    const { node, budgets } = setup({ isExhausted: true });
    budgets.check.mockImplementation(() => {
      throw new Error("exhausted");
    });
    const run = newRunContext({ runId: "run-1", signal: AbortSignal.abort() });

    await expect(node(stateOf(), { configurable: { run } })).rejects.toThrow("exhausted");

    expect(budgets.check).toHaveBeenCalledOnce();
  });

  it("a run that was cancelled stops before the check, when no budget was exhausted", async () => {
    const { node, budgets } = setup();
    const run = newRunContext({ runId: "run-1", signal: AbortSignal.abort() });

    await expect(node(stateOf(), { configurable: { run } })).rejects.toBeInstanceOf(
      ExecutionCancelledError,
    );

    expect(budgets.check).not.toHaveBeenCalled();
  });

  it("an exhausted signal that did not stop the loop is still checked once, then again before the call", async () => {
    const { node, budgets } = setup({ isExhausted: true });

    await node(stateOf(), undefined);

    expect(budgets.check).toHaveBeenCalledTimes(2);
  });

  it("the call in flight is aborted by the budgets' exhausted signal, and by the caller's too", async () => {
    const { node, invoke, exhausted } = setup();
    const caller = new AbortController();

    await node(stateOf(), { signal: caller.signal });
    await node(stateOf(), undefined);

    const [, bound] = invoke.mock.calls[0] ?? [];
    const [, alone] = invoke.mock.calls[1] ?? [];
    const signalOf = (call: unknown): AbortSignal => (call as { signal: AbortSignal }).signal;
    expect(signalOf(bound).aborted).toBe(false);
    caller.abort();
    expect(signalOf(bound).aborted).toBe(true);
    expect(signalOf(alone)).toBe(exhausted.signal);
  });
});

describe("#1366: the agent's limits", () => {
  it("a call past `modelCalls` is refused before it is made: the limit, its count and the loop's spend", async () => {
    const { node, invoke } = setup({ modelCalls: 2 });

    const failure = await node(stateOf({ modelCalls: 2 }), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(LimitExceededError);
    expect(failure).toMatchObject({ limit: 2, actual: 3, path: ["a", "b"], spentUsd: usd(1.5) });
    expect((failure as LimitExceededError).usage).toEqual([record(0.5, "loop")]);
    expect((failure as Error).message).toContain("agents.alpha.limits.modelCalls");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the last call the limit allows is made", async () => {
    const { node, invoke } = setup({ modelCalls: 2 });

    await node(stateOf({ modelCalls: 1 }), undefined);

    expect(invoke).toHaveBeenCalledOnce();
  });

  it("calls for more tools than `toolCalls` fail the agent with what the loop spent and this call cost", async () => {
    const { node } = setup({ toolCalls: 2 });
    vi.mocked(outgoingMove).mockImplementation(() =>
      Promise.resolve({
        kind: "move" as const,
        move: answerOf(0.25, [
          { id: "1", name: "t" },
          { id: "2", name: "t" },
        ]),
        usage: [record(0.0625, "check")],
      }),
    );

    const failure = await node(stateOf({ toolCalls: 1 }), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(LimitExceededError);
    expect(failure).toMatchObject({ limit: 2, actual: 3, spentUsd: 1.5 + 0.125 + 0.25 + 0.0625 });
    expect((failure as LimitExceededError).usage.map((u) => u.costUsd)).toEqual([
      0.5, 0.125, 0.25, 0.0625,
    ]);
    expect((failure as Error).message).toContain("agents.alpha.limits.toolCalls");
  });

  it("calls for exactly `toolCalls` tools are allowed", async () => {
    const { node } = setup({ toolCalls: 2 });
    vi.mocked(outgoingMove).mockImplementation(() =>
      Promise.resolve({
        kind: "move" as const,
        move: answerOf(0.25, [
          { id: "1", name: "t" },
          { id: "2", name: "t" },
        ]),
        usage: [],
      }),
    );

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({ toolCalls: 2, modelCalls: 1 });
  });
});

describe("#1366: the spend of a call is counted at once", () => {
  it("what the request masked and the call cost are tallied on the flow path, then what the answer's check cost", async () => {
    const { node, budgets, order } = setup();

    const out = await node(stateOf(), undefined);

    const [first, second] = budgets.tally.mock.calls;
    expect(first?.[0].map((u) => u.costUsd)).toEqual([0.125, 0.25]);
    expect(first?.[1]).toEqual(["a", "b"]);
    expect(second?.[0]).toEqual([record(0.0625, "check")]);
    expect(second?.[1]).toEqual(["a", "b"]);
    expect(order).toEqual(["check", "call", "tally", "tally"]);
    expect((out as { usage: UsageRecord[] }).usage.map((u) => u.costUsd)).toEqual([
      0.125, 0.25, 0.0625,
    ]);
  });

  it("a move with no tools is no check of the spend: the answer is kept, the next step stops", async () => {
    const { node, budgets } = setup();

    await node(stateOf(), undefined);

    expect(budgets.check).toHaveBeenCalledOnce();
  });

  it("a move that asks for tools checks the budgets again, with the spend of the call added to the state's", async () => {
    const { node, budgets } = setup();
    vi.mocked(outgoingMove).mockImplementation(() =>
      Promise.resolve({
        kind: "move" as const,
        move: answerOf(0.25, [{ id: "1", name: "t" }]),
        usage: [record(0.0625, "check")],
      }),
    );

    await node(stateOf(), undefined);

    expect(budgets.check).toHaveBeenCalledTimes(2);
    const spent = [
      record(0.125, "mask"),
      expect.objectContaining({ costUsd: usd(0.25) }),
      record(0.0625, "check"),
    ];
    expect(budgets.check).toHaveBeenLastCalledWith(
      [record(1, "before"), record(0.5, "loop"), ...spent],
      ["a", "b"],
      [record(0.5, "loop"), ...spent],
    );
  });

  it("an exhausted budget after the call refuses the tools: the error comes before the move is returned", async () => {
    const { node, budgets } = setup();
    vi.mocked(outgoingMove).mockImplementation(() =>
      Promise.resolve({
        kind: "move" as const,
        move: answerOf(0.25, [{ id: "1", name: "t" }]),
        usage: [],
      }),
    );
    budgets.check
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("spent");
      });

    await expect(node(stateOf(), undefined)).rejects.toThrow("spent");
  });

  it("an invalid answer costs a retry: its spend is not tallied here and no tool limit applies", async () => {
    const { node, budgets } = setup();
    vi.mocked(outgoingMove).mockResolvedValue({
      kind: "invalid",
      update: { usage: [record(0.5, "x")] },
    } as never);

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({
      usage: [record(0.5, "x")],
      modelCalls: 1,
      piiTokens: {},
      piiMasked: {},
    });
    expect(budgets.tally).toHaveBeenCalledOnce();
  });

  it("returns the move, the call and tool counts: answer calls are no tool calls", async () => {
    const { node } = setup({ toolCalls: 0 });
    vi.mocked(outgoingMove).mockImplementation(() =>
      Promise.resolve({ kind: "move" as const, move: answerOf(0.25), usage: [] }),
    );

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({ modelCalls: 1, toolCalls: 0 });
    expect((out as { move: AIMessage }).move.text).toBe("answer");
  });
});

describe("#1366: what the move asks for", () => {
  const moveOf = (
    calls: { id: string; name: string }[],
    invalid: { id: string; name: string }[] = [],
  ) =>
    new AIMessage({
      content: "answer",
      tool_calls: calls.map((call) => ({ ...call, args: {}, type: "tool_call" as const })),
      invalid_tool_calls: invalid.map((call) => ({
        ...call,
        args: "{",
        error: "bad",
        type: "invalid_tool_call" as const,
      })),
      response_metadata: { usage: { cost: 0.25 } },
    });
  const returning = (move: AIMessage) =>
    vi
      .mocked(outgoingMove)
      .mockImplementation(() => Promise.resolve({ kind: "move" as const, move, usage: [] }));

  it("tool calls and the calls whose arguments were no JSON both count against `toolCalls`", async () => {
    const { node } = setup({ toolCalls: 1 });
    returning(moveOf([{ id: "1", name: "t" }], [{ id: "2", name: "t" }]));

    const failure = await node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toMatchObject({ limit: 1, actual: 2 });
  });

  it("an answer tool is no tool call, whether its arguments parsed or not", async () => {
    const { node, deps } = setup({ toolCalls: 0 });
    deps.agent.answerTools = {
      tools: [{ name: "answer-x", definition: { function: { name: "answer-x" } } }],
    } as never;
    returning(moveOf([{ id: "1", name: "answer-x" }], [{ id: "2", name: "answer-x" }]));

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({ toolCalls: 0 });
  });

  it("only the calls that are not answers are counted when both kinds are in the move", async () => {
    const { node, deps } = setup({ toolCalls: 5 });
    deps.agent.answerTools = {
      tools: [{ name: "answer-x", definition: { function: { name: "answer-x" } } }],
    } as never;
    returning(
      moveOf(
        [
          { id: "1", name: "t" },
          { id: "2", name: "answer-x" },
        ],
        [
          { id: "3", name: "t" },
          { id: "4", name: "answer-x" },
        ],
      ),
    );

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({ toolCalls: 2 });
  });

  it("a turn that goes to tools has its text retracted; a reply does not", async () => {
    const tools = setup();
    returning(moveOf([{ id: "1", name: "t" }]));
    await tools.node(stateOf(), undefined);
    const reply = setup();
    returning(moveOf([]));
    await reply.node(stateOf(), undefined);

    expect(tools.attempt.discard).toHaveBeenCalledWith(StreamDiscardReason.ToolTurn);
    expect(reply.attempt.discard).not.toHaveBeenCalled();
  });

  it("an invalid answer has its text retracted, and no tool is run on it", async () => {
    const { node, attempt } = setup();
    vi.mocked(outgoingMove).mockResolvedValue({ kind: "invalid", update: { usage: [] } } as never);

    await node(stateOf(), undefined);

    expect(attempt.discard).toHaveBeenCalledWith(StreamDiscardReason.InvalidAnswer);
  });

  it("an agent with no stream of its answer has nothing to retract", async () => {
    const { node } = setup();
    vi.mocked(attemptOf).mockReturnValue(undefined);
    vi.mocked(outgoingMove).mockResolvedValue({ kind: "invalid", update: { usage: [] } } as never);

    const out = await node(stateOf(), undefined);
    vi.mocked(outgoingMove).mockImplementation((move) =>
      Promise.resolve({ kind: "move" as const, move, usage: [] }),
    );

    expect(out).toMatchObject({ modelCalls: 1 });
  });

  it("an agent that reads through PII policies has its tokens revealed in the stream: the state's and the request's", async () => {
    const { node } = setup();
    vi.mocked(loopPoliciesOf).mockReturnValue({} as never);
    vi.mocked(maskedRequest).mockResolvedValue({
      messages: [new SystemMessage("rules"), new HumanMessage("hi")],
      tokens: { b: "2" },
      cache: {},
      blocked: [],
      usage: [],
    });

    await node(stateOf({ piiTokens: { a: "1" } }), undefined);

    expect(vi.mocked(attemptOf).mock.calls[0]?.[3]).toEqual({ a: "1", b: "2" });
  });

  it("one that reads through none streams with no tokens", async () => {
    const { node } = setup();

    await node(stateOf({ piiTokens: { a: "1" } }), undefined);

    expect(vi.mocked(attemptOf).mock.calls[0]?.[3]).toBeUndefined();
  });
});

describe("#1366: the spend of a call that broke", () => {
  it("fails the agent with the loop's spend and what masking the request cost: the call itself is unknown", async () => {
    const { node, invoke, attempt } = setup();
    invoke.mockRejectedValue(new Error("provider down"));

    const failure = await node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect((failure as AgentFailedError).usage).toEqual([
      record(0.5, "loop"),
      record(0.125, "mask"),
    ]);
    expect((failure as AgentFailedError).cause).toEqual(new Error("provider down"));
    expect(attempt.discard).toHaveBeenCalledWith(StreamDiscardReason.StreamBroken);
  });

  it("a call that broke is not tallied here: the failure carries its spend to the ledger", async () => {
    const { node, invoke, budgets } = setup();
    invoke.mockRejectedValue(new Error("provider down"));

    await node(stateOf(), undefined).catch(() => undefined);

    expect(budgets.tally).not.toHaveBeenCalled();
  });
});

describe("#1366: what the observer hears of a model call", () => {
  it("the start: the model, the agent and what was sent, without the instructions", async () => {
    const { deps } = setup();
    const onModelStart = vi.fn();
    const withObserver = makeModelNode({
      ...deps,
      observer: { onModelStart, onModelEnd: vi.fn() },
    } as never);

    await withObserver(stateOf(), undefined);

    expect(onModelStart).toHaveBeenCalledWith({
      base: true,
      model: "m",
      provider: "(none)",
      caller: "alpha",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("the end: the text, the tokens and their sum, and the cost of the call", async () => {
    const { deps, invoke } = setup();
    invoke.mockResolvedValue(
      new AIMessage({
        content: "answer",
        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        response_metadata: { usage: { cost: 0.25 } },
      }),
    );
    const onModelEnd = vi.fn();
    const withObserver = makeModelNode({
      ...deps,
      observer: { onModelStart: vi.fn(), onModelEnd },
    } as never);

    await withObserver(stateOf(), undefined);

    expect(onModelEnd).toHaveBeenCalledWith({
      base: true,
      model: "m",
      provider: "(none)",
      caller: "alpha",
      content: "answer",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: usd(0.25),
    });
  });

  it("an agent with no observer is heard by none, and the call goes on", async () => {
    const { node } = setup();

    await expect(node(stateOf(), undefined)).resolves.toMatchObject({ modelCalls: 1 });
  });

  it("a call that broke tells the end to nobody; its text is retracted, once the failure is made", async () => {
    const { deps, invoke } = setup();
    invoke.mockRejectedValue(new Error("provider down"));
    const onModelEnd = vi.fn();
    const withObserver = makeModelNode({
      ...deps,
      observer: { onModelStart: vi.fn(), onModelEnd },
    } as never);

    await withObserver(stateOf(), undefined).catch(() => undefined);

    expect(onModelEnd).not.toHaveBeenCalled();
  });

  it("the text of a call that went through is held no longer", async () => {
    const { node, attempt } = setup();

    await node(stateOf(), undefined);

    expect(attempt.end).toHaveBeenCalledOnce();
  });
});
