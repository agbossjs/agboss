import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { scoreTurns, type EvalDeps } from "../../../src/eval/eval.js";
import { CostSource } from "../../../src/finops/cost-source.js";
import { decisionSpendOf } from "../../../src/finops/failed-decision.js";
import { createModelGateway } from "../../../src/llm/gateway.js";
import { resolveSettings } from "../../../src/llm/registry.js";
import { withPartialSpend } from "../../../src/models/transport/stream-partial.js";
import { createJevRouter, createLlmRouter } from "../../../src/routers/index.js";
import { usd } from "../../../src/units/index.js";
import { fakeDeps, memoryLedger, routeTo, runText, testConfig } from "../../helpers.js";
import { request } from "../../routers/fixtures.js";

/**
 * #1399: a failed model call outside a step's frame (an eval run's judge, a decision the provider
 * answered and billed but whose answer does not fit) charges what it spent: to the eval's own spend,
 * to the error, never dropped.
 */

const settings = resolveSettings(
  { model: "test/router", price: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } },
  testConfig.defaults.models,
);

describe("#1399: an eval's judge call that fails mid-way", () => {
  it("its partial spend is recorded in the application's budgets and ledger and counted in the report", async () => {
    const ledger = memoryLedger();
    const script: Record<string, string[]> = {
      "test/router": [routeTo("alpha-agent")],
      "test/alpha": ["an answer"],
    };
    const deps = await fakeDeps(script, { ledger });
    await runText("a task", deps);
    const model = new FakeListChatModel({ responses: ["x"] });
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const broken = withPartialSpend(new Error("stream broke"), { usage }) as Error;
    model.invoke = () => Promise.reject(broken);
    const evaluation: EvalDeps = {
      turns: deps.turns,
      budgets: deps.budgets,
      judge: createLlmRouter({ name: "judge", model, settings }),
    };
    const turns = await deps.turns.unscored("test-bundle-workflow", undefined, 10);
    ledger.recorded.length = 0;

    const report = await scoreTurns(evaluation, turns);

    expect(report.scored).toBe(0);
    const partial = ledger.recorded.filter(
      (record) => record.inputTokens === 100 && record.outputTokens === 50,
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ caller: "router:judge", costSource: CostSource.PriceTable });
    expect(report.costUsd).toBeGreaterThan(usd(0));
  });
});

describe("#1399: a decision the provider answered and billed, whose answer does not fit", () => {
  const questions = { q: { type: "boolean", instructions: "ok?" } } as const;
  const asked = { caller: "judge:j", model: "typesafe/jev-1", request: { state: "hi", questions } };
  const gatewayOver = (answer: unknown) =>
    createModelGateway({
      chatModel: () => new FakeListChatModel({ responses: [] }),
      jevClient: () => Promise.resolve(answer),
    });

  it("the provider's report is recorded once, as the provider priced it", async () => {
    const gateway = gatewayOver({
      answers: { q: { type: "choice" } },
      usage: { input_tokens: 10, output_tokens: 5, cost: 0.002 },
    });

    const error = await gateway.decide(asked).catch((thrown: unknown) => thrown);

    expect(decisionSpendOf(error)).toMatchObject({
      caller: "judge:j",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: usd(0.002),
      costSource: CostSource.Api,
    });
  });

  it("with no report its tokens are estimated and unpriced, never dropped", async () => {
    const gateway = gatewayOver({ answers: {} });

    const error = await gateway.decide(asked).catch((thrown: unknown) => thrown);

    const record = decisionSpendOf(error);
    expect(record).toMatchObject({ costUsd: usd(0), costSource: CostSource.Unpriced });
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.outputTokens).toBeGreaterThan(0);
  });

  it("a call that got no answer at all records nothing", async () => {
    const down = new Error("network");
    const gateway = createModelGateway({
      chatModel: () => new FakeListChatModel({ responses: [] }),
      jevClient: () => Promise.reject(down),
    });

    const error = await gateway.decide(asked).catch((thrown: unknown) => thrown);

    expect(error).toBe(down);
    expect(decisionSpendOf(error)).toBeUndefined();
  });

  it("a jev router's unreadable answer keeps the provider's report on the failed outcome", async () => {
    const router = createJevRouter({
      name: "main",
      model: "typesafe/jev-1",
      client: () =>
        Promise.resolve({ answers: {}, usage: { input_tokens: 7, output_tokens: 3, cost: 0.001 } }),
    });

    const outcome = await router.route(request);

    expect(outcome.kind).toBe("failed");
    expect(outcome.usage).toMatchObject({
      caller: "router:main",
      inputTokens: 7,
      outputTokens: 3,
      costUsd: usd(0.001),
      costSource: CostSource.Api,
    });
  });
});
