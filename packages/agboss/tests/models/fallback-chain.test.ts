/**
 * #1313c: a provider's `fallback` — a chain `A → B → C` with the model each hop is asked for, the
 * rules that refuse a cycle and a fallback of the other kind, and which failures go to the next hop.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { fallbackMarkOf } from "../../src/finops/fallback-mark.js";
import { fallbackCycleOf, fallbackHopsOf } from "../../src/models/fallback-chain.js";
import { FallbackChatModel, isFailoverError } from "../../src/models/fallback-chat-model.js";
import {
  DecisionsDriver,
  ModelCallError,
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
} from "../../src/models/index.js";
import { providerFallbackViolations } from "../../src/models/provider-mode-rules.js";
import { seconds, usd } from "../../src/units/index.js";

const common = { timeout: seconds(5) };
const driver = OpenAiCompatibleDriver({ baseUrl: "http://x.test/v1" });

@ModelProvider({
  ...common,
  driver,
  models: { default: "c/big", fast: "c/small" },
  cost: ModelCost.fromPrices({ "c/big": { inputPerMillion: usd(1), outputPerMillion: usd(2) } }),
})
class Third {}

@ModelProvider({
  ...common,
  driver,
  models: { default: "b/big", fast: "b/small" },
  fallback: Third,
})
class Second {}

@ModelProvider({
  ...common,
  driver,
  models: { default: "a/big", fast: "a/small" },
  fallback: { provider: Second, models: { "a/exact": "b/exact" } },
})
class First {}

@ModelProvider({ ...common, driver, model: "solo/one", fallback: Second })
class Solo {}

@ModelProvider({ ...common, driver: DecisionsDriver({ baseUrl: "http://d.test" }), model: "d/one" })
class Decides {}

@ModelProvider({ ...common, driver, model: "x/1", fallback: Decides })
class ChatToDecisions {}

describe("#1313c: the hops of a fallback chain", () => {
  it("a role the first provider's model has goes to the same role of each hop", () => {
    expect(fallbackHopsOf(First, "a/big").map((hop) => [hop.options.name, hop.model])).toEqual([
      ["second", "b/big"],
      ["third", "c/big"],
    ]);
    expect(fallbackHopsOf(First, "a/small").map((hop) => hop.model)).toEqual([
      "b/small",
      "c/small",
    ]);
  });

  it("a mapping names the hop's model for one of the primary's; the next hop follows from it", () => {
    expect(fallbackHopsOf(First, "a/exact").map((hop) => hop.model)).toEqual([
      "b/exact",
      "a/exact",
    ]);
  });

  it("a model with no role and no mapping is sent as it is", () => {
    expect(fallbackHopsOf(First, "any/thing").map((hop) => hop.model)).toEqual([
      "any/thing",
      "any/thing",
    ]);
  });

  it("a provider with a single model asks its fallback for the default role", () => {
    expect(fallbackHopsOf(Solo, "solo/one").map((hop) => hop.model)).toEqual(["b/big", "c/big"]);
  });

  it("a provider with no fallback has no hops", () => {
    expect(fallbackHopsOf(Third, "c/big")).toEqual([]);
  });
});

describe("#1313c: the fallback rules", () => {
  it("a chat provider's fallback that decides is [model.incompatible-fallback-provider]", () => {
    const found = providerFallbackViolations("app", [ChatToDecisions]);

    expect(found.map((one) => one.code)).toEqual(["model.incompatible-fallback-provider"]);
  });

  it("a good chain has none", () => {
    expect(providerFallbackViolations("app", [First])).toEqual([]);
  });

  it("a chain with no cycle has none (a cycle is [model-provider.fallback-cycle], never walked forever)", () => {
    expect(fallbackCycleOf(Third)).toBeUndefined();
    expect(fallbackCycleOf(First)).toBeUndefined();
    expect(fallbackCycleOf(Solo)).toBeUndefined();
  });
});

describe("#1313c: which failures go to the fallback", () => {
  const status = (value: number): Error => Object.assign(new Error("http"), { status: value });

  it("a refused key, a missing model, a quota, a timeout, a 429 and a 5xx do", () => {
    for (const value of [401, 402, 403, 404, 408, 429, 500, 503])
      expect(isFailoverError(status(value), undefined)).toBe(true);
  });

  it("a request the provider refused as wrong (a 400, a 422) does not", () => {
    for (const value of [400, 413, 422])
      expect(isFailoverError(status(value), undefined)).toBe(false);
  });

  it("a broken connection or an error with no status does, found through its causes", () => {
    expect(isFailoverError(new Error("socket hang up"), undefined)).toBe(true);
    expect(isFailoverError(new Error("wrapped", { cause: status(503) }), undefined)).toBe(true);
    expect(isFailoverError(new Error("wrapped", { cause: status(400) }), undefined)).toBe(false);
  });

  it("an input the model cannot take does not; an open breaker does", () => {
    const refused = new ModelCallError({
      code: "model.unsupported-input",
      provider: "p",
      message: "no",
    });
    const open = new ModelCallError({ code: "model.circuit-open", provider: "p", message: "open" });

    expect(isFailoverError(refused, undefined)).toBe(false);
    expect(isFailoverError(open, undefined)).toBe(true);
  });

  it("nothing does after the caller cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    expect(isFailoverError(status(503), controller.signal)).toBe(false);
  });
});

/** A chat model that answers its text, or fails with its error. */
class Scripted extends BaseChatModel {
  calls = 0;
  constructor(private readonly outcome: string | Error) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    if (this.outcome instanceof Error) return Promise.reject(this.outcome);
    const message = new AIMessage({ content: this.outcome });
    return Promise.resolve({ generations: [{ text: this.outcome, message }] });
  }
}

const hop = (model: Scripted, provider: string) => ({
  chatModel: () => model,
  model: `${provider}/m`,
  cost: undefined,
  provider,
});

const ask = (chat: FallbackChatModel, signal?: AbortSignal) =>
  chat.invoke([new HumanMessage("hi")], signal === undefined ? {} : { signal });

describe("#1313c: a call down the chain", () => {
  const down = Object.assign(new Error("unavailable"), { status: 503 });

  it("a primary that failed after its retries is answered once by the first hop that answers", async () => {
    const [primary, second, third] = [
      new Scripted(down),
      new Scripted(down),
      new Scripted("from third"),
    ];
    const chat = new FallbackChatModel({
      primary,
      hops: [hop(second, "second"), hop(third, "third")],
    });

    const answer = await ask(chat);

    expect(answer.text).toBe("from third");
    expect([primary.calls, second.calls, third.calls]).toEqual([1, 1, 1]);
    const mark = fallbackMarkOf(answer.response_metadata);
    expect(mark).toMatchObject({ provider: "third", model: "third/m", unpriced: true });
  });

  it("a request the primary refused as wrong is not sent on: the fallback is not called", async () => {
    const wrong = Object.assign(new Error("bad request"), { status: 400 });
    const [primary, backup] = [new Scripted(wrong), new Scripted("never")];
    const chat = new FallbackChatModel({ primary, hops: [hop(backup, "backup")] });

    await expect(ask(chat)).rejects.toBe(wrong);

    expect(backup.calls).toBe(0);
  });

  it("when every hop fails the last error is the call's", async () => {
    const last = Object.assign(new Error("also down"), { status: 502 });
    const chat = new FallbackChatModel({
      primary: new Scripted(down),
      hops: [hop(new Scripted(down), "second"), hop(new Scripted(last), "third")],
    });

    await expect(ask(chat)).rejects.toBe(last);
  });

  it("a primary that answers is never mixed with the chain", async () => {
    const backup = new Scripted("never");
    const chat = new FallbackChatModel({
      primary: new Scripted("from primary"),
      hops: [hop(backup, "backup")],
    });

    const answer = await ask(chat);

    expect(answer.text).toBe("from primary");
    expect(fallbackMarkOf(answer.response_metadata)).toBeUndefined();
    expect(backup.calls).toBe(0);
  });
});
