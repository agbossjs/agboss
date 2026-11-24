import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../../src/llm/jev-client.js";
import { createJevRouter } from "../../src/routers/index.js";
import { jevAnswer, request } from "./fixtures.js";

const jevWith = (response: unknown) => {
  const client = vi.fn<JevClient>(() => Promise.resolve(response));
  return { client, router: createJevRouter({ name: "main", model: "typesafe/jev-1.13", client }) };
};

describe("Jev router", () => {
  it("sends the input as state and every option as a criterion", async () => {
    const { client, router } = jevWith(jevAnswer({ choice: "alpha" }));

    await router.route(request);

    expect(client).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "typesafe/jev-1.13",
        state: "Implement a parser",
        questions: {
          route: expect.objectContaining({
            type: "choice",
            criteria: { alpha: "facts", finish: "done" },
          }) as unknown,
        },
      }),
    );
  });

  it("decides with probability as reason and API-reported cost", async () => {
    const { router } = jevWith(
      jevAnswer(
        { choice: "alpha", probabilities: { alpha: 0.934, finish: 0.066 } },
        { cost: 1e-5 },
      ),
    );

    expect(await router.route(request)).toMatchObject({
      kind: "decided",
      decision: { next: "alpha", reason: "jev confidence 0.93" },
      usage: {
        caller: "router:main",
        model: "typesafe/jev-1.13-20260917",
        costUsd: 1e-5,
        costSource: "api",
      },
    });
  });

  it("falls back to confidence and total_cost fields", async () => {
    const { router } = jevWith(
      jevAnswer({ choice: "finish", confidence: 0.8 }, { total_cost: 2e-5 }),
    );

    expect(await router.route(request)).toMatchObject({
      decision: { reason: "jev confidence 0.80" },
      usage: { costUsd: 2e-5 },
    });
  });

  it("uses a plain reason and zero cost when the API omits them", async () => {
    const { router } = jevWith({ answers: { route: { choice: "alpha" } } });

    expect(await router.route(request)).toMatchObject({
      decision: { reason: "jev" },
      usage: { model: "typesafe/jev-1.13", costUsd: 0 },
    });
  });

  it("AC1: fails on a choice outside the options and names it", async () => {
    const { router } = jevWith(jevAnswer({ choice: "ghost" }));

    expect(await router.route(request)).toMatchObject({
      kind: "failed",
      reason: "unknown route: ghost",
      unknownOption: "ghost",
    });
  });

  it("fails on a malformed response", async () => {
    const { router } = jevWith({ unexpected: true });

    expect(await router.route(request)).toMatchObject({
      kind: "failed",
      reason: "invalid router output",
    });
  });

  it("fails safely when the API call throws", async () => {
    const router = createJevRouter({
      name: "main",
      model: "m",
      client: () => Promise.reject(new Error("402")),
    });

    expect(await router.route(request)).toMatchObject({
      kind: "failed",
      reason: "router error: 402",
    });
  });
});
