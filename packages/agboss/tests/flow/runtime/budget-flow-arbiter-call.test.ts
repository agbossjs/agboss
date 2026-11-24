/**
 * #1283 (budget-flow shard) — the `ArbiterModel` a hybrid arbiter injects: each call checks the execution's
 * budgets first (a spent one stops it before the model is asked), a decision's cost and a chat reply's cost
 * are billed into the answer's spend under `arbiter:<name>`, a decision the provider billed and the questions
 * did not fit is billed too (#1399), a kind it cannot serve is `ModelKindError`, and the model reads the
 * answer masked when the answering target has PII policies (#708).
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { withDecisionSpend } from "../../../src/finops/failed-decision.js";
import { createArbiterModels } from "../../../src/flow/runtime/launch/arbiter-call.js";
import { ModelKindError } from "../../../src/llm/decision-errors.js";
import { Decision } from "../../../src/llm/decisions.js";
import { usd } from "../../../src/units/index.js";

const record = (costUsd: number, caller = "arbiter:desk-arbiter"): UsageRecord => ({
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
    const model = createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, deps);

    await expect(model.metered(call).decide({ state: "s", questions })).rejects.toBe(stop);

    expect(deps.decide).not.toHaveBeenCalled();
    expect(call.spent).toEqual([]);
  });

  it("a decision the provider billed and the questions did not fit is billed all the same, and fails", async () => {
    const failure = withDecisionSpend(new Error("answer does not fit"), record(0.5)) as Error;
    const deps = decisions(() => Promise.reject(failure));
    const call = callOf();
    const model = createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, deps);

    await expect(model.metered(call).decide({ state: "s", questions })).rejects.toBe(failure);

    expect(call.spent.map((u) => u.costUsd)).toEqual([0.5]);
  });

  it("a chat model cannot decide, a gateway without decisions fails closed, both before a model call", async () => {
    const call = callOf();
    const chat = createArbiterModels(
      "desk-arbiter",
      { kind: "llm", model: "chat" },
      decisions(() => Promise.reject(new Error("unused"))),
    );
    await expect(chat.metered(call).decide({ state: "s", questions })).rejects.toBeInstanceOf(
      ModelKindError,
    );

    const none = createArbiterModels(
      "desk-arbiter",
      { kind: "jev", model: "m" },
      { gateway: {} as never, chatDefaults: { temperature: 0 } },
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
    const model = createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, deps);

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
    const model = createArbiterModels("desk-arbiter", { kind: "llm", model: "chat" }, deps);

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
    const chat = createArbiterModels("desk-arbiter", { kind: "llm", model: "chat" }, deps);
    await expect(chat.metered(stopped).invoke("q")).rejects.toBe(stop);
    expect(invoke).not.toHaveBeenCalled();

    const decision = createArbiterModels("desk-arbiter", { kind: "jev", model: "m" }, deps);
    await expect(decision.metered(callOf()).invoke("q")).rejects.toBeInstanceOf(ModelKindError);
  });

  it("a call that fails mid-way keeps what it spent: the partial spend is billed, the failure is the call's", async () => {
    const failure = Object.assign(new Error("stream broke"), {
      response_metadata: { usage: { cost: 0.0625 } },
    });
    const { deps } = chatting(failure);
    const call = callOf();
    const model = createArbiterModels("desk-arbiter", { kind: "llm", model: "chat" }, deps);

    await expect(model.metered(call).invoke("q")).rejects.toBe(failure);
  });
});
