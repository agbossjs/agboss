import { usd } from "../../src/units/index.js";
/**
 * #1366: the usage an LLM router's outcome carries — the call's, priced; and a record of no cost when the call
 * threw, so a router that failed is still one call on the ledger's trace.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../../src/llm/registry.js";
import { createLlmRouter } from "../../src/routers/index.js";
import { testConfig } from "../helpers.js";
import { request } from "./fixtures.js";

const settings = resolveSettings(
  { model: "test/router", price: { inputPerMillion: usd(1), outputPerMillion: usd(1) } },
  testConfig.defaults.models,
);

describe("#1366: the usage of an LLM router's outcome", () => {
  it("a call that threw is a failed outcome with one record of no cost, under the router's caller", async () => {
    const model = new FakeListChatModel({ responses: ["x"] });
    model.invoke = () => Promise.reject(new Error("the provider is down"));

    const outcome = await createLlmRouter({ name: "main", model, settings }).route(request);

    expect(outcome.kind).toBe("failed");
    expect(outcome.usage).toMatchObject({ caller: "router:main", costUsd: usd(0) });
  });

  it("an answer that is no decision is a failed outcome that keeps the call's usage", async () => {
    const model = new FakeListChatModel({ responses: ["not json at all"] });

    const outcome = await createLlmRouter({ name: "main", model, settings }).route(request);

    expect(outcome.kind).toBe("failed");
    expect(outcome.usage).toMatchObject({ caller: "router:main", costSource: "price-table" });
  });
});
