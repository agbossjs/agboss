import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../../src/llm/jev-client.js";
import { createRouter } from "../../src/routers/index.js";
import { fakeChatFactory, fakeGateway, testConfig, testRouter } from "../helpers.js";
import { jevAnswer, request } from "./fixtures.js";
import { usd } from "../../src/units/index.js";

describe("createRouter", () => {
  it("builds a Jev router for kind jev", async () => {
    const client = vi.fn<JevClient>(() => Promise.resolve(jevAnswer({ choice: "finish" })));
    const router = createRouter(
      "main",
      testRouter,
      testConfig.defaults.models,
      fakeGateway(fakeChatFactory({}), client),
    );

    await router.route(request);

    expect(router.name).toBe("main");
    expect(client).toHaveBeenCalledOnce();
  });

  it("builds an LLM router with chat defaults applied for kind llm", async () => {
    const chatModel = vi.fn(fakeChatFactory({ "test/router": ['{"next":"alpha"}'] }));
    const model = {
      kind: "llm",
      model: "test/router",
      price: { inputPerMillion: usd(1), outputPerMillion: usd(2) },
    } as const;

    await createRouter("main", model, testConfig.defaults.models, fakeGateway(chatModel)).route(
      request,
    );

    expect(chatModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test/router", maxTokens: "max", price: model.price }),
    );
  });
});

describe("trivial option sets", () => {
  const client = () => vi.fn<JevClient>(() => Promise.resolve(jevAnswer({ choice: "alpha" })));
  const router = (jevClient: JevClient) =>
    createRouter(
      "main",
      testRouter,
      testConfig.defaults.models,
      fakeGateway(fakeChatFactory({}), jevClient),
    );

  it("skips the call for a single option", async () => {
    const jev = client();

    const outcome = await router(jev).route({
      input: "x",
      options: [{ name: "alpha", description: "a" }],
    });

    expect(outcome).toEqual({
      kind: "decided",
      decision: { next: "alpha", reason: "single option" },
    });
    expect(jev).not.toHaveBeenCalled();
  });

  it("fails without a call when there is nothing to route to", async () => {
    const jev = client();

    expect(await router(jev).route({ input: "x", options: [] })).toEqual({
      kind: "failed",
      reason: "no options to route to",
    });
    expect(jev).not.toHaveBeenCalled();
  });
});
