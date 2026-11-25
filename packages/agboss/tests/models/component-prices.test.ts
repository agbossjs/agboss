import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
/**
 * Bughunt 2026-11-25 #2 (regression): every model use is priced by its own provider and model. A model
 * router and a model reranker on a provider whose `cost` is a price table failed every call with a
 * `ConfigError.ModelCost` (the router's paid call then recorded at 0 USD, the reranker's dropped under
 * `Fallback`), and a router was billed at the price of an agent on another provider whose model had the
 * same name. Each case runs the application on stubbed OpenAI-compatible servers, as production does.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { CostSource } from "../../src/finops/usage.js";
import { RerankFailurePolicy } from "../../src/rag/index.js";
import { usd } from "../../src/units/index.js";
import type { Class } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { appWithKeys } from "./gateway.js";
import { completion, providerStub, type StubReply } from "./stub.js";
import {
  BareLocalProvider,
  PricedLocalProvider,
  PRICES,
  ReportingProvider,
  rerankerApplication,
  routerApplication,
} from "./fixtures/component-prices.workflow.js";

/** The stub's tokens of every answer: 10 in, 5 out. */
const costAt = (price: { readonly input: number; readonly output: number }): number =>
  (10 * price.input + 5 * price.output) / 1_000_000;

const MODELS = [{ id: "p/agent" }, { id: "p/router" }, { id: "p/rerank" }, { id: "bare/rerank" }];

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function started(application: Class, replies: readonly StubReply[]): Promise<App> {
  const stub = providerStub(replies, MODELS);
  app = await appWithKeys(application, { processEnv: {}, providerFetch: stub.fetch });
  return app;
}

/** The router's answer: the agent on the priced server. */
const routed = completion(JSON.stringify({ next: "priced-answer-agent", reason: "here" }));

describe("bughunt #2: a model router on a price-table provider", () => {
  it("is priced by its own provider's table: no ConfigError.ModelCost, the call in the spend and its tokens", async () => {
    const { application, start } = routerApplication(PricedLocalProvider);
    const running = await started(application, [routed, completion("done")]);

    const result = await execute(running, start, { text: "hi" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.spend.byCaller["router:priced-router"]).toBeCloseTo(costAt(PRICES.router), 12);
    expect(result.spend.trace).toContainEqual(
      expect.objectContaining({
        caller: "router:priced-router",
        model: "p/router",
        provider: "priced-local-model-provider",
        costSource: CostSource.PriceTable,
      }),
    );
    expect(result.spend.totalUsd).toBeCloseTo(costAt(PRICES.router) + costAt(PRICES.agent), 12);
    expect(result.spend.totalTokens).toBe(30);
  });

  it("an agent on another provider whose model has the router's name does not price the router", async () => {
    const { application, start } = routerApplication(PricedLocalProvider, { withOther: true });
    const running = await started(application, [routed, completion("done")]);

    const result = await execute(running, start, { text: "hi" });

    // its own table's 10 / 20 per million, never the other provider's 1000 / 2000
    expect(result.spend.byCaller["router:priced-router"]).toBeCloseTo(costAt(PRICES.router), 12);
    expect(result.spend.byProvider["other-priced-model-provider"] ?? usd(0)).toBe(0);
  });

  it("the budget counts the router's call: an execution budget below it stops the agent's call", async () => {
    const { application, start } = routerApplication(PricedLocalProvider, {
      maxSpend: usd(0.0001),
    });
    const running = await started(application, [routed, completion("done")]);

    await expect(execute(running, start, { text: "hi" })).rejects.toFailWith(LimitError.Budget, {
      budget: { name: "component-prices-execution-budget" },
    });
  });

  it("an answer the provider billed and no price accounts keeps its tokens: never a 0-token record", async () => {
    const { application, start } = routerApplication(ReportingProvider);
    // the provider answers and reports no cost: the call cannot be priced, it still spent its tokens
    const running = await started(application, [routed, completion("done")]);

    const failure: unknown = await execute(running, start, { text: "hi" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StepError.Router);
    expect((failure as StepError.Router).usage).toEqual([
      expect.objectContaining({
        caller: "router:priced-router",
        provider: "reporting-model-provider",
        inputTokens: 10,
        outputTokens: 5,
        costSource: CostSource.Unpriced,
      }),
    ]);
  });
});

/** The reranker's answer: the second candidate first. */
const ranked = completion('{"ranking":[2,1]}');

describe("bughunt #2: a model reranker", () => {
  it("on a price-table provider is priced by its table, even beside an agent on the same server", async () => {
    const { application, start } = rerankerApplication(PricedLocalProvider, "p/rerank");
    const running = await started(application, [ranked, completion("done")]);

    const result = await execute(running, start, { text: "which?" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.spend.byCaller["reranker:priced-reranker"]).toBeCloseTo(
      costAt(PRICES.rerank),
      12,
    );
    expect(result.spend.trace).toContainEqual(
      expect.objectContaining({
        caller: "reranker:priced-reranker",
        provider: "priced-local-model-provider",
        costSource: CostSource.PriceTable,
      }),
    );
  });

  it("on a provider with no cost is unpriced: 0 USD, its tokens counted", async () => {
    const { application, start } = rerankerApplication(BareLocalProvider, "bare/rerank");
    const running = await started(application, [ranked, completion("done")]);

    const result = await execute(running, start, { text: "which?" });

    expect(result.spend.trace).toContainEqual(
      expect.objectContaining({
        caller: "reranker:priced-reranker",
        provider: "bare-local-model-provider",
        inputTokens: 10,
        outputTokens: 5,
        costSource: CostSource.Unpriced,
      }),
    );
  });

  it("under Fallback a reply with no ranking keeps the paid call's spend", async () => {
    const { application, start } = rerankerApplication(
      PricedLocalProvider,
      "p/rerank",
      RerankFailurePolicy.Fallback,
    );
    const running = await started(application, [completion("no idea"), completion("done")]);

    const result = await execute(running, start, { text: "which?" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.spend.byCaller["reranker:priced-reranker"]).toBeCloseTo(
      costAt(PRICES.rerank),
      12,
    );
  });
});
