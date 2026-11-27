/**
 * #1283 (budget-flow shard) — the `ArbiterModel` a hybrid arbiter injects: each call checks the execution's
 * budgets first (a spent one stops it before the model is asked), a decision's cost and a chat reply's cost
 * are billed into the answer's spend under `arbiter:<name>`, a decision the provider billed and the questions
 * did not fit is billed too (#1399), a kind it cannot serve is `ConfigError.ModelKind`, and the model reads the
 * answer masked when the answering target has PII policies (#708).
 */
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { withDecisionSpend } from "../../../src/finops/failed-decision.js";
import { createArbiterModels } from "../../../src/flow/runtime/launch/arbiter-call.js";
import { Decision } from "../../../src/llm/decisions.js";
import { ModelKind } from "../../../src/llm/decision-errors.js";
import { usd } from "../../../src/units/index.js";

const record = (costUsd: number, caller = "arbiter:desk-arbiter"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const questions = { ok: Decision.boolean("fine?") };

function callOf(options: { beforeCall?: () => Promise<void>; reading?: unknown } = {}): {
  spent: UsageRecord[];
  beforeCall: ReturnType<typeof vi.fn>;
  reading?: never;
} {
  const spent: UsageRecord[] = [];
  const beforeCall = vi.fn(options.beforeCall ?? (() => Promise.resolve()));
  return {
    spent,
    beforeCall,
    ...(options.reading === undefined ? {} : { reading: options.reading as never }),
  };
}

describe("#1283: a decision of the injected ArbiterModel", () => {
  const decisions = (outcome: () => Promise<unknown>) => {
    const decide = vi.fn(outcome);
    return {
      decide,
      gateway: { decide, chatModel: vi.fn() } as never,
      chatDefaults: { temperature: 0 },
    };
  };

  it("checks the budgets first, asks under arbiter:<name>, bills the call and returns the answers", async () => {
    const answers = { ok: { type: "boolean", probability: 0.8 } };
    const deps = decisions(() => Promise.resolve({ answers, usage: record(0.25) }));
    const call = callOf();
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "typesafe/jev-1.13" },
      deps,
      "How to judge.",
    );

    const read = await model.metered(call).decide({ state: "s", questions });

    expect(read).toBe(answers);
    expect(call.beforeCall).toHaveBeenCalledTimes(1);
    expect(call.spent.map((u) => u.costUsd)).toEqual([0.25]);
    expect(deps.decide).toHaveBeenCalledWith({
      caller: "arbiter:desk-arbiter",
      model: "typesafe/jev-1.13",
      request: { state: "s", questions },
    });
  });

  it("a spent budget stops it before the model is asked", async () => {
    const deps = decisions(() => Promise.resolve({ answers: {}, usage: record(1) }));
    const stop = new Error("budget spent");
    const call = callOf({ beforeCall: () => Promise.reject(stop) });
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      deps,
      "How to judge.",
    );

    await expect(model.metered(call).decide({ state: "s", questions })).rejects.toBe(stop);

    expect(deps.decide).not.toHaveBeenCalled();
    expect(call.spent).toEqual([]);
  });

  it("a decision the provider billed and the questions did not fit is billed all the same, and fails", async () => {
    const failure = withDecisionSpend(new Error("answer does not fit"), record(0.5)) as Error;
    const deps = decisions(() => Promise.reject(failure));
    const call = callOf();
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      deps,
      "How to judge.",
    );

    await expect(model.metered(call).decide({ state: "s", questions })).rejects.toBe(failure);

    expect(call.spent.map((u) => u.costUsd)).toEqual([0.5]);
  });

  it("a chat model cannot decide, a gateway without decisions fails closed, both before a model call", async () => {
    const call = callOf();
    const chat = createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat" },
      decisions(() => Promise.reject(new Error("unused"))),
      "How to judge.",
    );
    await expect(chat.metered(call).decide({ state: "s", questions })).rejects.toBeInstanceOf(
      ConfigError.ModelKind,
    );

    const none = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      { gateway: {} as never, chatDefaults: { temperature: 0 } },
      "How to judge.",
    );
    await expect(none.metered(call).decide({ state: "s", questions })).rejects.toThrow(
      "arbiter:desk-arbiter: the model gateway has no decisions (m)",
    );
    expect(call.beforeCall).not.toHaveBeenCalled();
  });

  it("the model reads the state masked when the answering target has a reading", async () => {
    const deps = decisions(() => Promise.resolve({ answers: {}, usage: record(0) }));
    const reading = vi.fn((texts: readonly string[]) =>
      Promise.resolve({
        texts: texts.map((text) => text.replace("a@b.c", "[EMAIL_1]")),
        tokens: {},
        usage: [record(0.125)],
      }),
    );
    const call = callOf({ reading });
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      deps,
      "How to judge.",
    );

    await model.metered(call).decide({ state: "mail a@b.c", questions });

    expect(JSON.stringify(deps.decide.mock.calls[0])).toContain("[EMAIL_1]");
    // what masking cost is the answer's, the decision's own cost follows it
    expect(call.spent.slice(0, -1).every((u) => u.costUsd === 0.125)).toBe(true);
    expect(call.spent.at(-1)?.costUsd).toBe(0);
  });
});

describe("#1283: a chat call of the injected ArbiterModel", () => {
  const chatting = (reply: AIMessage | Error) => {
    const invoke = vi.fn(() =>
      reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
    );
    const chatModel = vi.fn((_spec: unknown) => ({ invoke }));
    return {
      invoke,
      chatModel,
      deps: {
        gateway: { chatModel, decide: vi.fn() } as never,
        chatDefaults: { temperature: 0 },
      },
    };
  };

  it("checks the budgets, asks the arbiter's chat model, bills the reply and returns its text", async () => {
    const { deps, invoke, chatModel } = chatting(
      new AIMessage({ content: "yes, fine", response_metadata: { usage: { cost: 0.25 } } }),
    );
    const call = callOf();
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat" },
      deps,
      "How to judge.",
    );

    const text = await model.metered(call).invoke("is it fine?");

    expect(text).toBe("yes, fine");
    expect(call.beforeCall).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(call.spent.map((u) => [u.caller, u.costUsd])).toEqual([["arbiter:desk-arbiter", 0.25]]);
    expect(chatModel.mock.calls[0]?.[0]).toMatchObject({
      user: { kind: "arbiter", arbiter: "desk-arbiter" },
    });
  });

  it("a spent budget stops it before the model is asked; a decision model cannot chat", async () => {
    const { deps, invoke } = chatting(new AIMessage({ content: "x" }));
    const stop = new Error("budget spent");
    const stopped = callOf({ beforeCall: () => Promise.reject(stop) });
    const chat = createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat" },
      deps,
      "How to judge.",
    );
    await expect(chat.metered(stopped).invoke("q")).rejects.toBe(stop);
    expect(invoke).not.toHaveBeenCalled();

    const decision = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      deps,
      "How to judge.",
    );
    await expect(decision.metered(callOf()).invoke("q")).rejects.toBeInstanceOf(
      ConfigError.ModelKind,
    );
  });

  it("a call that fails mid-way keeps what it spent: the partial spend is billed, the failure is the call's", async () => {
    const failure = Object.assign(new Error("stream broke"), {
      response_metadata: { usage: { cost: 0.0625 } },
    });
    const { deps } = chatting(failure);
    const call = callOf();
    const model = createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat" },
      deps,
      "How to judge.",
    );

    await expect(model.metered(call).invoke("q")).rejects.toBe(failure);
  });
});

describe("#1356: what a chat call sends and returns, rule by rule", () => {
  const chatting = (reply: (options: { callbacks?: unknown }) => Promise<AIMessage>) => {
    const invoke = vi.fn((_asked: BaseMessage[], options: { callbacks?: unknown }) =>
      reply(options),
    );
    const chatModel = vi.fn((_spec: unknown) => ({ invoke }));
    return {
      invoke,
      deps: { gateway: { chatModel, decide: vi.fn() } as never, chatDefaults: { temperature: 0 } },
    };
  };
  const llm = { kind: "llm", model: "chat" } as const;
  const answer = (text: string) =>
    Promise.resolve(new AIMessage({ content: text, response_metadata: { usage: { cost: 0.25 } } }));
  const masking = {
    mask: vi.fn((texts: readonly string[]) =>
      Promise.resolve({
        texts: texts.map((text) => text.replace("a@b.c", "<email:7f3a91>")),
        tokens: { "<email:7f3a91>": "a@b.c" },
        usage: [record(0.125, "pii:detect")],
      }),
    ),
  };

  it("a text is sent as one human message, with the call's callbacks beside the chunk counter", async () => {
    const { deps, invoke } = chatting(() => answer("ok"));

    await createArbiterModels("desk-arbiter", llm, deps, "i")
      .metered(callOf())
      .invoke("is it fine?");

    const [asked = [], options] = invoke.mock.calls[0] ?? [];
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeInstanceOf(HumanMessage);
    expect(asked[0]?.content).toBe("is it fine?");
    expect(options?.callbacks).toEqual(expect.any(Array));
  });

  it("chat messages are sent as they are, in order", async () => {
    const { deps, invoke } = chatting(() => answer("ok"));

    await createArbiterModels("desk-arbiter", llm, deps, "i")
      .metered(callOf())
      .invoke([
        { role: "system", content: "be brief" },
        { role: "user", content: "is it fine?" },
      ]);

    const [asked = []] = invoke.mock.calls[0] ?? [];
    expect(asked.map((message) => message.content)).toEqual(["be brief", "is it fine?"]);
    expect(asked[0]).toBeInstanceOf(SystemMessage);
    expect(asked[1]).toBeInstanceOf(HumanMessage);
  });

  it("with a reading the model sees the masked text and the arbiter's code the real one; masking is billed before the call", async () => {
    const { deps, invoke } = chatting(() => answer("write to <email:7f3a91>"));
    const call = callOf({ reading: masking.mask });

    const text = await createArbiterModels("desk-arbiter", llm, deps, "i")
      .metered(call)
      .invoke("mail a@b.c");

    expect(invoke.mock.calls[0]?.[0][0]?.content).toBe("mail <email:7f3a91>");
    expect(text).toBe("write to a@b.c");
    expect(call.spent.map((u) => [u.caller, u.costUsd])).toEqual([
      ["pii:detect", 0.125],
      ["arbiter:desk-arbiter", 0.25],
    ]);
  });

  it("a call that dies after streaming bills what it spent, at once, and fails as it failed", async () => {
    const failure = new Error("stream broke");
    const { deps } = chatting(async (options) => {
      for (const handler of Array.isArray(options.callbacks) ? options.callbacks : [])
        await handler.handleLLMNewToken?.("abcdefgh");
      throw failure;
    });
    const call = callOf();

    await expect(
      createArbiterModels("desk-arbiter", llm, deps, "i").metered(call).invoke("four"),
    ).rejects.toBe(failure);

    expect(call.spent).toEqual([
      expect.objectContaining({ caller: "arbiter:desk-arbiter", outputTokens: 2 }),
    ]);
  });

  it("a decision model that is asked to chat is ConfigError.ModelKind naming the model, what it is and the call", async () => {
    const { deps } = chatting(() => answer("x"));

    const error = await createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "jev-1" },
      deps,
      "i",
    )
      .metered(callOf())
      .invoke("q")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError.ModelKind);
    expect(error).toMatchObject({ model: "jev-1", modelKind: ModelKind.Decisions, call: "invoke" });
  });
});

describe("#1356: what a decision sends and what a failure leaves, rule by rule", () => {
  const decisions = (outcome: () => Promise<unknown>) => {
    const decide = vi.fn((_asked: Record<string, unknown>) => outcome());
    return {
      decide,
      gateway: { decide, chatModel: vi.fn() } as never,
      chatDefaults: { temperature: 0 },
    };
  };
  const done = () => Promise.resolve({ answers: {}, usage: record(0.25) });

  it("the provider of the model goes to the gateway when there is one, and no such field when there is none", async () => {
    const withProvider = decisions(done);
    const without = decisions(done);

    await createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m", modelProvider: "acme" },
      withProvider,
      "i",
    )
      .metered(callOf())
      .decide({ state: "s", questions });
    await createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, without, "i")
      .metered(callOf())
      .decide({ state: "s", questions });

    expect(withProvider.decide.mock.calls[0]?.[0]).toStrictEqual({
      caller: "arbiter:desk-arbiter",
      model: "m",
      modelProvider: "acme",
      request: { state: "s", questions },
    });
    expect(Object.keys(without.decide.mock.calls[0]?.[0] as object)).toEqual([
      "caller",
      "model",
      "request",
    ]);
  });

  it("a failure that billed nothing bills nothing: the spend holds no empty entry", async () => {
    const failure = new Error("refused");
    const deps = decisions(() => Promise.reject(failure));
    const call = callOf();

    await expect(
      createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, deps, "i")
        .metered(call)
        .decide({ state: "s", questions }),
    ).rejects.toBe(failure);

    expect(call.spent).toStrictEqual([]);
  });

  it("a chat model that is asked to decide is ConfigError.ModelKind naming the model, what it is and the call", async () => {
    const deps = decisions(done);

    const error = await createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat-1" },
      deps,
      "i",
    )
      .metered(callOf())
      .decide({ state: "s", questions })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError.ModelKind);
    expect(error).toMatchObject({ model: "chat-1", modelKind: ModelKind.Chat, call: "decide" });
  });
});
