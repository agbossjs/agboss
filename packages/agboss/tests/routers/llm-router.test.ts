import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { resolveSettings } from "../../src/llm/registry.js";
import { createLlmRouter } from "../../src/routers/index.js";
import { routeTo, testConfig } from "../helpers.js";
import { request } from "./fixtures.js";
import { usd } from "../../src/units/index.js";

const settings = resolveSettings(
  { model: "test/router", price: { inputPerMillion: usd(1), outputPerMillion: usd(1) } },
  testConfig.defaults.models,
);
const llm = (responses: string[]) =>
  createLlmRouter({ name: "main", model: new FakeListChatModel({ responses }), settings });

describe("LLM router", () => {
  it("decides from valid JSON and prices usage from the table", async () => {
    expect(await llm([routeTo("alpha", "facts needed")]).route(request)).toMatchObject({
      kind: "decided",
      decision: { next: "alpha", reason: "facts needed" },
      usage: { caller: "router:main", costSource: "price-table" },
    });
  });

  it("puts a specific question before the input", async () => {
    const model = new FakeListChatModel({ responses: [routeTo("finish")] });
    const invoke = vi.spyOn(model, "invoke");

    await createLlmRouter({ name: "guard", model, settings }).route({
      ...request,
      instructions: "Is this unsafe?",
    });

    expect(JSON.stringify(invoke.mock.calls[0]?.[0])).toContain(
      "Is this unsafe?\\n\\nImplement a parser",
    );
  });

  it("parses JSON wrapped in a code fence", async () => {
    const fenced = "```json\n" + routeTo("finish", "done") + "\n```";

    expect(await llm([fenced]).route(request)).toMatchObject({ decision: { next: "finish" } });
  });

  it("defaults a missing reason to an empty string", async () => {
    expect(await llm(['{"next":"alpha"}']).route(request)).toMatchObject({
      decision: { next: "alpha", reason: "" },
    });
  });

  it("AC1: fails on an unknown option and names it", async () => {
    expect(await llm([routeTo("ghost")]).route(request)).toMatchObject({
      kind: "failed",
      reason: "unknown route: ghost",
      unknownOption: "ghost",
    });
  });

  it("fails on text that is not JSON", async () => {
    expect(await llm(["I think alpha"]).route(request)).toMatchObject({ kind: "failed" });
  });

  it("fails safely when the model throws a non-Error", async () => {
    const model = new FakeListChatModel({ responses: [] });
    vi.spyOn(model, "invoke").mockRejectedValue("timeout");

    const outcome = await createLlmRouter({ name: "main", model, settings }).route(request);

    expect(outcome).toMatchObject({ kind: "failed", reason: "router error: timeout" });
  });
});
