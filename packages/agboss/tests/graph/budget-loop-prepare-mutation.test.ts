/**
 * #1356 (budget-loop shard) — preparing the calls of a move, rule by rule over fakes: the arguments of a plain tool and of
 * a question role are checked once, a plain tool's are kept as the model gave them and a question's as its ask parsed
 * them; the PII search is told the tokens the earlier calls made; what it spent and what the hooks reported is the
 * loop's spend, whichever way the call ended; an `allow({ input })` is searched again; a call with no hook opens
 * no frame; what a move's entries start from and what an approver's override leaves behind.
 */
import { createHash } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { newRunContext } from "../../src/core/run-context.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { currentFrame, inToolCallFrame } from "../../src/flow/context/frame.js";
import { inTestFrame } from "../helpers/frame.js";
import {
  argsDigestOf,
  freshEntriesOf,
  unknownToolPrepared,
  withoutOverride,
} from "../../src/graph/agent-loop/move-entries.js";
import { makePrepareNode } from "../../src/graph/agent-loop/prepare-node.js";
import { PreparedFrom } from "../../src/graph/agent-loop/state.js";
import { keepStopCause } from "../../src/graph/agent-loop/tool-stops.js";
import { ToolCallDecision } from "../../src/tool-interceptors/decision.js";
import { usd } from "../../src/units/index.js";

vi.mock("../../src/graph/agent-loop/tool-stops.js", async (original) => ({
  ...(await original<typeof import("../../src/graph/agent-loop/tool-stops.js")>()),
  keepStopCause: vi.fn(),
}));
vi.mock("../../src/flow/context/frame.js", async (original) => {
  const real = await original<typeof import("../../src/flow/context/frame.js")>();
  return { ...real, inToolCallFrame: vi.fn(real.inToolCallFrame) };
});

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const callsOf = (...calls: { id: string; name: string; args: Record<string, unknown> }[]) =>
  new AIMessage({
    content: "",
    tool_calls: calls.map((call) => ({ ...call, type: "tool_call" as const })),
  });

const stateOf = (move: AIMessage, changes: object = {}) =>
  ({
    runId: "run-1",
    move,
    results: {},
    decisions: {},
    prepared: {},
    piiTokens: {},
    piiValues: [],
    piiKey: null,
    ...changes,
  }) as never;

const oneCall = (name: string, args: Record<string, unknown>, changes: object = {}) =>
  stateOf(callsOf({ id: "c1", name, args }), changes);

const tally = vi.fn((records: readonly UsageRecord[]) => records);
const budgets = { exhausted: new AbortController().signal, tally, remaining: () => 5 };

/** A tool whose input check is `safeParse`; by default it takes any arguments as they are. */
const toolOf = (changes: object = {}) => ({
  name: "write-tool",
  timeout: 30_000,
  input: { safeParse: (args: unknown) => ({ success: true, data: args }) },
  ...changes,
});

/** A PII policy set over fakes: every string `s` is masked to `<s>`, its spend and tokens reported. */
const piiSet = (changes: object = {}) => {
  const set = {
    isEmpty: false,
    withValues: () => set,
    withFieldKey: () => set,
    mask: vi.fn((text: string, _known: unknown) =>
      Promise.resolve({
        masked: { text: `<${text}>`, blocked: [], tokens: { [`<${text}>`]: text } },
        usage: [record(0.125, "pii:detect")],
      }),
    ),
    refusalError: vi.fn(() => Promise.resolve(undefined)),
    ...changes,
  };
  return set;
};

const chainOf = (instance: object) => ({
  name: "gate",
  instance,
  toolType: undefined,
  beforeMethod: undefined,
});

const nodeOf = (options: { tools?: object[]; pii?: object; interceptors?: object[] } = {}) => {
  const node = makePrepareNode({
    agent: { name: "alpha", tools: options.tools ?? [toolOf()] },
    budgets,
    ...(options.pii === undefined ? {} : { pii: options.pii }),
    ...(options.interceptors === undefined ? {} : { interceptors: () => options.interceptors }),
  } as never);
  // in a step's frame, as the loop runs: what a hook reports has a step to go to
  return (state: Parameters<typeof node>[0], config: Parameters<typeof node>[1]) =>
    inTestFrame(async () => node(state, config));
};

beforeEach(() => {
  vi.clearAllMocks();
  tally.mockImplementation((records) => records);
});

describe("#1356: the entries of a move and an override's decision", () => {
  it("a new move drops the entries of every call it makes, valid or not, in all five channels", () => {
    const move = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "t", args: {}, type: "tool_call" }],
      invalid_tool_calls: [
        { id: "c2", name: "t", args: "{", error: "bad", type: "invalid_tool_call" },
      ],
    });

    const fresh = freshEntriesOf(move);

    const dropped = { c1: undefined, c2: undefined };
    expect(Object.keys(fresh)).toEqual([
      "results",
      "decisions",
      "prepared",
      "questionAnswers",
      "callRecords",
    ]);
    for (const channel of Object.values(fresh)) {
      expect(Object.keys(channel)).toEqual(["c1", "c2"]);
      expect(channel).toStrictEqual(dropped);
    }
    expect(freshEntriesOf(null).results).toStrictEqual({});
  });

  it("an approver's override leaves the decision without the arguments, with the reason only when there is one", () => {
    expect(withoutOverride(undefined)).toBeUndefined();
    expect(withoutOverride({ approved: true, by: "ada" })).toBeUndefined();
    expect(
      withoutOverride({ approved: true, by: "ada", overrideInput: { x: 1 }, reason: "ok" }),
    ).toStrictEqual({ approved: true, by: "ada", reason: "ok" });
    expect(withoutOverride({ approved: false, by: "bob", overrideInput: { x: 1 } })).toStrictEqual({
      approved: false,
      by: "bob",
    });
  });

  it("the digest of the arguments is the sha256 of their JSON with the keys in order, and a call to no tool is invalid", () => {
    const expected = createHash("sha256").update('{"a":1,"b":{"c":2,"d":3}}').digest("hex");

    expect(argsDigestOf({ b: { d: 3, c: 2 }, a: 1 })).toBe(expected);
    expect(unknownToolPrepared({ callId: "c9", tool: "ghost", args: { a: 1 } })).toStrictEqual({
      tool: "ghost",
      argsDigest: argsDigestOf({ a: 1 }),
      args: { a: 1 },
      from: PreparedFrom.Model,
      kind: "invalid",
    });
  });
});

describe("#1356: the arguments of a call, checked and kept", () => {
  it("a plain tool's arguments that do not parse end the call as invalid and no question is asked", async () => {
    const tool = toolOf({
      input: {
        safeParse: () => ({
          success: false,
          error: { issues: [{ path: ["to"], message: "Required" }] },
        }),
      },
    });

    const out = await nodeOf({ tools: [tool] })(oneCall("write-tool", { x: 1 }), undefined);

    expect(out.prepared).toMatchObject({ c1: { kind: "invalid", args: { x: 1 } } });
    expect(Object.keys(out.questionAnswers ?? {})).toEqual([]);
  });

  it("a plain tool's arguments are kept as the model gave them, not as its input parsed them", async () => {
    const tool = toolOf({
      input: { safeParse: () => ({ success: true, data: { parsed: true } }) },
    });

    const out = await nodeOf({ tools: [tool] })(oneCall("write-tool", { raw: 1 }), undefined);

    expect(out.prepared).toMatchObject({
      c1: { kind: "ready", args: { raw: 1 }, shown: { raw: 1 } },
    });
  });

  it("a question's arguments are its ask as its input parsed it: that is what is shown and searched", async () => {
    const tool = toolOf({
      name: "ask-tool",
      question: {},
      input: { safeParse: () => ({ success: true, data: { to: "ada", defaulted: 1 } }) },
    });
    const set = piiSet();

    const out = await nodeOf({ tools: [tool], pii: set })(
      oneCall("ask-tool", { to: "ada" }),
      undefined,
    );

    expect(set.mask).toHaveBeenCalledOnce();
    expect(out.prepared).toMatchObject({
      c1: { kind: "ready", shown: { to: "<ada>", defaulted: 1 } },
    });
  });

  it("a cancelled run prepares no call", async () => {
    const run = newRunContext({ runId: "run-1", signal: AbortSignal.abort() });
    const config = { configurable: { run } };

    await expect(nodeOf()(oneCall("write-tool", { to: "a" }), config)).rejects.toBeInstanceOf(
      ExecutionCancelledError,
    );
  });

  it("a call that has no tool is invalid, and cancelling is not looked at for it", async () => {
    const out = await nodeOf()(oneCall("ghost", { to: "a" }), undefined);

    expect(out.prepared).toStrictEqual({
      c1: unknownToolPrepared({ callId: "c1", tool: "ghost", args: { to: "a" } }),
    });
  });
});

describe("#1356: what an earlier call made is known to the search of the next", () => {
  it("the search is told the tokens the state holds and the ones the calls before made, in the move's order", async () => {
    const set = piiSet();
    const state = stateOf(
      callsOf(
        { id: "c1", name: "write-tool", args: { to: "a" } },
        { id: "c2", name: "write-tool", args: { to: "b" } },
      ),
      { piiTokens: { "<old>": "old" } },
    );

    const out = await nodeOf({ pii: set })(state, undefined);

    expect(set.mask.mock.calls.map(([text, known]) => [text, known])).toEqual([
      ["a", { "<old>": "old" }],
      ["b", { "<old>": "old", "<a>": "a" }],
    ]);
    expect(out.piiTokens).toEqual({ "<a>": "a", "<b>": "b" });
    expect(out.usage).toEqual([record(0.125, "pii:detect"), record(0.125, "pii:detect")]);
  });

  it("an approver's override is dropped from the decision kept, a decision without one is not kept at all", async () => {
    const withOverride = oneCall(
      "write-tool",
      { to: "a" },
      {
        decisions: { c1: { approved: true, by: "ada", overrideInput: { to: "z" } } },
      },
    );
    const without = oneCall(
      "write-tool",
      { to: "a" },
      {
        decisions: { c1: { approved: true, by: "ada" } },
      },
    );

    const kept = await nodeOf()(withOverride, undefined);
    const none = await nodeOf()(without, undefined);

    expect(kept.decisions).toStrictEqual({ c1: { approved: true, by: "ada" } });
    expect(none.decisions).toStrictEqual({});
    expect(kept.prepared).toMatchObject({ c1: { from: PreparedFrom.Approver, args: { to: "z" } } });
  });

  it("a PII rule that blocks a kind refuses the call, and what its search spent is still the loop's", async () => {
    const refusal = { content: "refused", refusal: new Error("blocked") };
    const set = piiSet({
      refusalError: vi.fn(() =>
        Promise.resolve(Object.assign(new Error("blocked"), { code: "pii.refused" })),
      ),
    });
    void refusal;

    const out = await nodeOf({ pii: set })(oneCall("write-tool", { to: "a" }), undefined);

    expect(out.prepared).toMatchObject({ c1: { kind: "refused" } });
    expect(out.usage).toEqual([record(0.125, "pii:detect")]);
  });
});

describe("#1356: a call through hooks", () => {
  it("a call with no hook opens no frame; one with a hook opens one with the call id", async () => {
    await nodeOf()(oneCall("write-tool", { to: "a" }), undefined);
    expect(inToolCallFrame).not.toHaveBeenCalled();

    await nodeOf({ interceptors: [chainOf({ beforeAnyTool: () => ToolCallDecision.allow() })] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );
    expect(inToolCallFrame).toHaveBeenCalledOnce();
    expect(vi.mocked(inToolCallFrame).mock.calls[0]?.[0]).toBe("c1");
  });

  it("a hook that answers or blocks ends the call with the spend of the search and of the hook, and the search's tokens", async () => {
    const set = piiSet();
    const gate = {
      beforeAnyTool: () => {
        currentFrame()?.services.reportUsage?.(record(0.5, "plain-service"));
        currentFrame()?.services.reportUsage?.(record(0.25, "rag:docs"));
        return ToolCallDecision.reply("use the cache");
      },
    };

    const out = await nodeOf({ pii: set, interceptors: [chainOf(gate)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(out.prepared).toMatchObject({ c1: { kind: "replied", message: "use the cache" } });
    expect(tally).toHaveBeenCalledTimes(2);
    expect(tally.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ caller: "tool:write-tool", costUsd: usd(0.5) }),
    ]);
    expect(tally.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ caller: "rag:docs", costUsd: usd(0.25) }),
    ]);
    expect(out.usage).toEqual([
      record(0.125, "pii:detect"),
      expect.objectContaining({ caller: "tool:write-tool", costUsd: usd(0.5) }),
      expect.objectContaining({ caller: "rag:docs", costUsd: usd(0.25) }),
    ]);
    expect(out.piiTokens).toEqual({ "<a>": "a" });
  });

  it("a tool with a cost caller of its own bills the hooks' spend to it", async () => {
    const gate = {
      beforeAnyTool: () => {
        currentFrame()?.services.reportUsage?.(record(0.5, "service"));
        return ToolCallDecision.allow();
      },
    };

    const out = await nodeOf({
      tools: [toolOf({ costCaller: "billing:pay" })],
      interceptors: [chainOf(gate)],
    })(oneCall("write-tool", { to: "a" }), undefined);

    expect(out.usage).toEqual([expect.objectContaining({ caller: "billing:pay" })]);
  });

  it("the hooks are told whose call it is: the agent, the call id, the tool and the arguments", async () => {
    const seen: unknown[] = [];
    const gate = {
      beforeAnyTool: (context: object) => {
        seen.push(context);
        return ToolCallDecision.allow();
      },
    };

    await nodeOf({ interceptors: [chainOf(gate)] })(oneCall("write-tool", { to: "a" }), undefined);

    expect(seen).toEqual([
      expect.objectContaining({
        callId: "c1",
        agent: expect.objectContaining({ name: "alpha" }),
        tool: expect.objectContaining({ name: "write-tool" }),
        input: { to: "a" },
      }),
    ]);
  });

  it("a hook that fails stops the call, and its error is kept for the step's failure", async () => {
    const crash = new Error("the hook crashed");
    const gate = {
      beforeAnyTool: () => {
        throw crash;
      },
    };

    const out = await nodeOf({ interceptors: [chainOf(gate)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(out.prepared).toMatchObject({
      c1: { kind: "stopped", stop: { interceptor: "gate", reason: "the hook crashed" } },
    });
    expect(keepStopCause).toHaveBeenCalledWith("run-1", "c1", crash);
  });

  it("the remote execution a hook reports is kept with the call, and a call with none has no such key", async () => {
    const remote = { application: "peer", executionId: "e-1" };
    const reporting = {
      beforeAnyTool: () => {
        currentFrame()?.services.meshCall?.recordRemote(remote as never);
        return ToolCallDecision.allow();
      },
    };
    const silent = { beforeAnyTool: () => ToolCallDecision.allow() };
    const stopped = {
      beforeAnyTool: () => {
        currentFrame()?.services.meshCall?.recordRemote(remote as never);
        return ToolCallDecision.block("no");
      },
    };

    const kept = await nodeOf({ interceptors: [chainOf(reporting)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );
    const none = await nodeOf({ interceptors: [chainOf(silent)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );
    const ended = await nodeOf({ interceptors: [chainOf(stopped)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(kept.prepared?.c1).toMatchObject({ kind: "ready", remote });
    expect(Object.keys(none.prepared?.c1 ?? {})).not.toContain("remote");
    expect(ended.prepared?.c1).toMatchObject({ kind: "stopped", remote });
  });

  it("an allow({ input }) is validated, searched again with the tokens known, and its spend and tokens join the first search's", async () => {
    const set = piiSet();
    const gate = { beforeAnyTool: () => ToolCallDecision.allow({ input: { to: "b" } }) };

    const out = await nodeOf({ pii: set, interceptors: [chainOf(gate)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(set.mask.mock.calls.map(([text, known]) => [text, known])).toEqual([
      ["a", {}],
      ["b", {}],
    ]);
    expect(out.prepared).toMatchObject({
      c1: { kind: "ready", args: { to: "b" }, shown: { to: "<b>" } },
    });
    expect(out.usage).toEqual([record(0.125, "pii:detect"), record(0.125, "pii:detect")]);
    expect(out.piiTokens).toEqual({ "<a>": "a", "<b>": "b" });
  });

  it("an allow({ input }) whose new arguments hold a blocked kind ends the call as refused", async () => {
    const set = piiSet({
      refusalError: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(Object.assign(new Error("blocked"), { code: "pii.refused" })),
    });
    const gate = { beforeAnyTool: () => ToolCallDecision.allow({ input: { to: "b" } }) };

    const out = await nodeOf({ pii: set, interceptors: [chainOf(gate)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(out.prepared).toMatchObject({ c1: { kind: "refused" } });
    expect(out.usage).toEqual([record(0.125, "pii:detect"), record(0.125, "pii:detect")]);
  });

  it("an allow() with no input is not searched again: the first search is the call's", async () => {
    const set = piiSet();
    const gate = { beforeAnyTool: () => ToolCallDecision.allow() };

    const out = await nodeOf({ pii: set, interceptors: [chainOf(gate)] })(
      oneCall("write-tool", { to: "a" }),
      undefined,
    );

    expect(set.mask).toHaveBeenCalledOnce();
    expect(set.refusalError).toHaveBeenCalledOnce();
    expect(out.usage).toEqual([record(0.125, "pii:detect")]);
    expect(out.prepared).toMatchObject({ c1: { kind: "ready", shown: { to: "<a>" } } });
  });
});
