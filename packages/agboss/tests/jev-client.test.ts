import { describe, expect, it, vi } from "vitest";
import { Decision } from "../src/llm/decisions.js";
import { createJevClient, JevApiError, jevDecisionsUrl } from "../src/llm/jev-client.js";
import { OPENROUTER_BASE_URL } from "../src/models/index.js";

const request = {
  model: "typesafe/jev-1.13",
  state: "text",
  questions: { route: { type: "choice" as const, instructions: "i", criteria: { a: "a" } } },
};

describe("jevDecisionsUrl", () => {
  it("maps the OpenRouter chat base URL to the Decisions endpoint", () => {
    expect(jevDecisionsUrl(OPENROUTER_BASE_URL)).toBe("https://openrouter.ai/api/alpha/decisions");
  });
});

describe("createJevClient", () => {
  it("posts the request with bearer auth and returns the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    );
    const client = createJevClient({ apiKey: "k", baseUrl: OPENROUTER_BASE_URL }, fetchImpl);

    const body = await client(request);

    expect(body).toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer k" });
    expect(init?.body).toBe(JSON.stringify(request));
  });

  it("throws JevApiError with status and body on HTTP errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("insufficient credits", { status: 402 })),
    );
    const client = createJevClient({ apiKey: "k", baseUrl: OPENROUTER_BASE_URL }, fetchImpl);

    await expect(client(request)).rejects.toThrow(
      new JevApiError("Decisions API 402: insufficient credits", {
        status: 402,
        body: "insufficient credits",
      }),
    );
  });

  it("sends a boolean question as the API's noul and reads its answer back as a probability", async () => {
    const answered = {
      model: "m",
      answers: {
        ok: { type: "noul", noul: 0.8 },
        route: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(answered), { status: 200 })),
    );
    const client = createJevClient({ apiKey: "k", baseUrl: OPENROUTER_BASE_URL }, fetchImpl);

    const body = await client({
      model: "typesafe/jev-1.13",
      state: "text",
      questions: {
        ok: Decision.boolean("Is it?", { true: "yes", false: "no" }),
        route: request.questions.route,
      },
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "typesafe/jev-1.13",
      state: "text",
      questions: {
        ok: { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } },
        route: request.questions.route,
      },
    });
    expect(body).toEqual({
      model: "m",
      answers: {
        ok: { type: "boolean", probability: 0.8 },
        route: answered.answers.route,
      },
    });
  });

  it("passes a body without answers through unchanged", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify([1, 2]), { status: 200 })),
    );
    const client = createJevClient({ apiKey: "k", baseUrl: OPENROUTER_BASE_URL }, fetchImpl);

    expect(await client(request)).toEqual([1, 2]);
  });
});
