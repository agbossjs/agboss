import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-reply shard) — the budget rules of reading one free-text reply by its interpreter, each on its own
 * over fakes: a model interpreter's call is checked against the tree's budgets before it is made (a code one makes
 * none), the spend of the reading travels with every outcome — a read, a decline, a decision that does not
 * validate — and the reading runs in the call's frame.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readReplyBy, replyReaderOf } from "../../src/channels/reply-reading.js";
import { readByCode } from "../../src/channels/reply-code.js";
import { readByDecision } from "../../src/channels/reply-decision.js";
import { readByModel } from "../../src/channels/reply-reader.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { ChannelInterpreterOutcome } from "../../src/flow/observers/channel-interpreter.js";
import { testFrame } from "../helpers/frame.js";

vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  runInFrame: vi.fn((_frame: unknown, work: () => unknown) => work()),
}));
vi.mock("../../src/channels/reply-code.js", async (original) => ({
  ...(await original<typeof import("../../src/channels/reply-code.js")>()),
  readByCode: vi.fn(),
}));
vi.mock("../../src/channels/reply-decision.js", () => ({ readByDecision: vi.fn() }));
vi.mock("../../src/channels/reply-reader.js", async (original) => ({
  ...(await original<typeof import("../../src/channels/reply-reader.js")>()),
  readByModel: vi.fn(),
}));
vi.mock("../../src/llm/registry.js", () => ({
  resolveSettings: vi.fn((settings: object, defaults: object) => ({
    ...defaults,
    ...settings,
    resolved: true,
  })),
}));

const record = (costUsd: number, caller = "reply"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const parts = {
  gateway: { name: "gateway", kindOf: vi.fn((): ModelKind | undefined => undefined) },
  chatModelSettings: vi.fn((model: string) => ({ temperature: 0, from: model })),
  chatDefaults: { defaults: true },
  instanceOf: vi.fn(() => ({ name: "instance" })),
  interpreters: [] as unknown[],
};

const interpreterOf = (model: string | undefined) => ({
  name: "boss-reply-interpreter",
  target: "tg",
  interpreter: Object,
  ...(model === undefined ? {} : { model }),
});

function callOf(changes: Record<string, unknown> = {}) {
  const order: string[] = [];
  const beforeModelCall = vi.fn(() => {
    order.push("check");
    return Promise.resolve();
  });
  const validate = vi.fn((decision: unknown) => decision);
  return {
    order,
    beforeModelCall,
    validate,
    call: {
      ask: { q: "?" },
      reply: "yes",
      label: "pause p1",
      validate,
      beforeModelCall,
      callbacks: ["cb"],
      frame: { frame: true },
      pii: { pii: true },
      ...changes,
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parts.gateway.kindOf).mockReturnValue(ModelKind.Chat);
});

describe("#1366: a model interpreter's call is checked first", () => {
  it("checks the budgets, then asks the chat model; the reading's spend is the outcome's", async () => {
    const { call, order, beforeModelCall } = callOf();
    vi.mocked(readByModel).mockImplementation(() => {
      order.push("model");
      return Promise.resolve({ kind: "answered", answer: { yes: 1 }, usage: [record(0.25)] });
    });

    const out = await readReplyBy(interpreterOf("some/chat-model") as never, call, parts as never);

    expect(order).toEqual(["check", "model"]);
    expect(beforeModelCall).toHaveBeenCalledOnce();
    expect(out).toEqual({ kind: "read", decision: { yes: 1 }, usage: [record(0.25)] });
    expect(vi.mocked(readByModel).mock.calls[0]?.slice(1)).toEqual([
      { ask: { q: "?" }, reply: "yes" },
      {
        gateway: parts.gateway,
        settings: {
          defaults: true,
          temperature: 0,
          from: "some/chat-model",
          model: "some/chat-model",
          resolved: true,
        },
        callbacks: ["cb"],
        pii: { pii: true },
      },
    ]);
  });

  it("tells the provider and the unpriced mark of the interpreter's model to its settings and to the gateway's kind", async () => {
    const { call } = callOf();
    vi.mocked(readByModel).mockResolvedValue({ kind: "answered", answer: 1, usage: [] });
    const interpreter = {
      ...interpreterOf("some/chat-model"),
      modelProvider: "acme",
      unpriced: true,
    };

    await readReplyBy(interpreter as never, call, parts as never);

    expect(parts.gateway.kindOf).toHaveBeenCalledWith("acme");
    expect(parts.chatModelSettings).toHaveBeenCalledWith("some/chat-model", "acme");
    expect(vi.mocked(readByModel).mock.calls[0]?.[2].settings).toStrictEqual({
      defaults: true,
      temperature: 0,
      from: "some/chat-model",
      model: "some/chat-model",
      modelProvider: "acme",
      unpriced: true,
      resolved: true,
    });
  });

  it("an interpreter's model with no provider and no unpriced mark has neither key in its settings", async () => {
    const { call } = callOf();
    vi.mocked(readByModel).mockResolvedValue({ kind: "answered", answer: 1, usage: [] });

    await readReplyBy(interpreterOf("some/chat-model") as never, call, parts as never);

    expect(parts.gateway.kindOf).toHaveBeenCalledWith(undefined);
    expect(parts.chatModelSettings).toHaveBeenCalledWith("some/chat-model", undefined);
    expect(Object.keys(vi.mocked(readByModel).mock.calls[0]?.[2].settings ?? {})).toEqual([
      "defaults",
      "temperature",
      "from",
      "model",
      "resolved",
    ]);
  });

  it("a gateway that cannot tell its models apart reads every one as a chat model", async () => {
    const { call } = callOf();
    vi.mocked(readByModel).mockResolvedValue({ kind: "answered", answer: 1, usage: [] });
    const bare = { ...parts, gateway: { name: "bare" } };

    await readReplyBy(interpreterOf("some/chat-model") as never, call, bare as never);

    expect(readByModel).toHaveBeenCalledOnce();
    expect(readByDecision).not.toHaveBeenCalled();
  });

  it("a decision model is read as one: its caller named for the interpreter, its gateway and model, and its PII", async () => {
    const { call, order } = callOf();
    vi.mocked(parts.gateway.kindOf).mockReturnValue(ModelKind.Decisions);
    vi.mocked(readByDecision).mockImplementation(() => {
      order.push("decision");
      return Promise.resolve({ kind: "answered", answer: true, usage: [] });
    });

    await readReplyBy(interpreterOf("decision/model") as never, call, parts as never);

    expect(order).toEqual(["check", "decision"]);
    expect(readByModel).not.toHaveBeenCalled();
    expect(vi.mocked(readByDecision).mock.calls[0]?.slice(1)).toEqual([
      { ask: { q: "?" }, reply: "yes" },
      {
        gateway: parts.gateway,
        model: "decision/model",
        caller: "channel-interpreter:boss-reply-interpreter",
        pii: { pii: true },
      },
    ]);
  });

  it("an exhausted budget refuses the call: the model is never asked", async () => {
    const { call, beforeModelCall } = callOf();
    beforeModelCall.mockRejectedValue(new Error("exhausted"));

    await expect(
      readReplyBy(interpreterOf("some/chat-model") as never, call, parts as never),
    ).rejects.toThrow("exhausted");

    expect(readByModel).not.toHaveBeenCalled();
    expect(readByDecision).not.toHaveBeenCalled();
  });

  it("a code interpreter makes no model call: no budget is checked", async () => {
    const { call, beforeModelCall } = callOf();
    vi.mocked(readByCode).mockResolvedValue({ kind: "answered", answer: { ok: 1 }, usage: [] });

    const out = await readReplyBy(interpreterOf(undefined) as never, call, parts as never);

    expect(beforeModelCall).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "read", decision: { ok: 1 }, usage: [] });
    expect(vi.mocked(readByCode).mock.calls[0]?.[1]).toEqual({ ask: { q: "?" }, reply: "yes" });
  });

  it("tells the observer of the paused execution, who reads and what it cost, around the reading", async () => {
    const onChannelInterpreterStart = vi.fn();
    const onChannelInterpreterEnd = vi.fn();
    const { call } = callOf({
      frame: testFrame(),
      observer: { onChannelInterpreterStart, onChannelInterpreterEnd },
    });
    vi.mocked(readByModel).mockResolvedValue({
      kind: "answered",
      answer: 1,
      usage: [record(0.25)],
    });

    await readReplyBy(interpreterOf("some/chat-model") as never, call, parts as never);

    const about = { interpreter: "boss-reply-interpreter", target: "tg", isCode: false };
    expect(onChannelInterpreterStart).toHaveBeenCalledWith(expect.objectContaining(about));
    expect(onChannelInterpreterEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        ...about,
        outcome: ChannelInterpreterOutcome.Read,
        costUsd: usd(0.25),
      }),
    );
  });

  it("the reading runs in the call's frame", async () => {
    const { call } = callOf();
    vi.mocked(readByModel).mockResolvedValue({ kind: "answered", answer: 1, usage: [] });

    await readReplyBy(interpreterOf("m") as never, call, parts as never);

    expect(vi.mocked(runInFrame).mock.calls[0]?.[0]).toEqual({ frame: true });
  });
});

describe("#1366: the reading's spend travels with every outcome", () => {
  it("a decline is unreadable, with the reason in the message and the spend kept", async () => {
    const { call } = callOf();
    const cause = new Error("odd");
    vi.mocked(readByModel).mockResolvedValue({
      kind: "declined",
      reason: "no idea",
      cause,
      usage: [record(0.5)],
    } as never);

    const out = await readReplyBy(interpreterOf("m") as never, call, parts as never);

    expect(out.kind).toBe("unreadable");
    expect(out.usage).toEqual([record(0.5)]);
    const error = (out as { error: PauseError.UninterpretableReply }).error;
    expect(error).toBeInstanceOf(PauseError.UninterpretableReply);
    expect(error.message).toBe(
      "pause p1: boss-reply-interpreter could not read the reply — no idea",
    );
    expect(error.cause).toBe(cause);
  });

  it("a decision that does not validate is unreadable with the validation's message and the spend kept", async () => {
    const { call, validate } = callOf();
    const invalid = new Error("not an approval");
    validate.mockImplementation(() => {
      throw invalid;
    });
    vi.mocked(readByModel).mockResolvedValue({
      kind: "answered",
      answer: {},
      usage: [record(0.25)],
    });

    const out = await readReplyBy(interpreterOf("m") as never, call, parts as never);

    expect(out.kind).toBe("unreadable");
    expect(out.usage).toEqual([record(0.25)]);
    expect((out as { error: Error }).error.message).toContain("not an approval");
    expect(validate).toHaveBeenCalledWith({});
  });

  it("a decision that validates is read: the validated value, not the interpreter's", async () => {
    const { call, validate } = callOf();
    validate.mockReturnValue({ approved: true });
    vi.mocked(readByModel).mockResolvedValue({ kind: "answered", answer: "raw", usage: [] });

    const out = await readReplyBy(interpreterOf("m") as never, call, parts as never);

    expect(out).toEqual({ kind: "read", decision: { approved: true }, usage: [] });
  });
});

describe("#1366: the reader of a tree's pauses", () => {
  it("finds the interpreter of the pause's channel and reads with the pause's own ask", async () => {
    const { call } = callOf();
    vi.mocked(readByCode).mockResolvedValue({ kind: "answered", answer: 1, usage: [] });
    const reader = replyReaderOf({
      ...parts,
      interpreters: [{ ...interpreterOf(undefined), target: "other" }, interpreterOf(undefined)],
    } as never);

    const out = await reader({
      ...(call as object),
      pause: { pauseId: "p9", target: "tg", channel: "ch", input: { asked: true } },
    } as never);

    expect(out.kind).toBe("read");
    expect(vi.mocked(readByCode).mock.calls[0]?.[1]).toEqual({
      ask: { asked: true },
      reply: "yes",
    });
  });

  it("labels the reading with the pause's id: a reply the interpreter declines says which pause it was for", async () => {
    const { call } = callOf();
    vi.mocked(readByCode).mockResolvedValue({ kind: "declined", reason: "unclear", usage: [] });
    const reader = replyReaderOf({ ...parts, interpreters: [interpreterOf(undefined)] } as never);

    const out = await reader({
      ...(call as object),
      pause: { pauseId: "p9", target: "tg", channel: "ch", ask: {} },
    } as never);

    expect((out as { error: Error }).error.message).toBe(
      "pause p9: boss-reply-interpreter could not read the reply — unclear",
    );
  });

  it("a channel with no interpreter is refused, naming the pause and the channel", async () => {
    const { call } = callOf();
    const reader = replyReaderOf({ ...parts, interpreters: [] } as never);

    const failure = await reader({
      ...(call as object),
      pause: { pauseId: "p9", target: "tg", channel: "ch", ask: {} },
    } as never).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PauseError.ChannelInterpreterMissing);
    expect((failure as Error).message).toContain(
      "pause p9: pause target tg has no channelInterpreter",
    );
  });
});
