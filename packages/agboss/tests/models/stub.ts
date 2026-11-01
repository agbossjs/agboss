import type { ProviderFetch } from "../../src/models/resilient-fetch.js";

/** One replyWith of the stub: a status, a JSON body, headers. */
export interface StubReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A request the stub got: its URL, headers and parsed JSON body. */
export interface StubRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | undefined;
  readonly raw: string | undefined;
}

const parsed = (raw: string | undefined): Record<string, unknown> | undefined => {
  try {
    return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return undefined;
  }
};

/** An OpenRouter `/models` entry. */
export interface StubModel {
  readonly id: string;
  readonly supported_parameters?: readonly string[];
  readonly reasoning?: {
    readonly mandatory?: boolean;
    readonly supported_efforts?: readonly string[];
  };
  readonly pricing?: Readonly<Record<string, string>>;
}

/** A chat completion replyWith, with OpenRouter's cost when given. */
export const completion = (text = "ok", cost?: number): StubReply => ({
  body: {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "a/b",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      ...(cost === undefined ? {} : { cost }),
    },
  },
});

/** One tool call of a scripted completion: the tool's name and its arguments. */
export interface StubToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A chat completion whose move calls `calls`, in order (#649: several in one move). */
export const toolCallsCompletion = (calls: readonly StubToolCall[], cost?: number): StubReply => ({
  body: {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "a/b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map(({ name, args }, index) => ({
            id: `call-${String(index + 1)}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      ...(cost === undefined ? {} : { cost }),
    },
  },
});

/** A chat completion that calls one tool (an answer tool, S6) with `args`. */
export const toolCallCompletion = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  cost?: number,
): StubReply => toolCallsCompletion([{ name, args }], cost);

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * A provider's HTTP side without a network: `GET …/models` answers `models`, every other request
 * gets the next reply (the last one repeats). Every request is recorded.
 */
export function providerStub(
  replies: readonly StubReply[] = [completion()],
  models: readonly StubModel[] = [],
): { readonly fetch: ProviderFetch; readonly requests: StubRequest[] } {
  const requests: StubRequest[] = [];
  let next = 0;
  const fetchStub: ProviderFetch = (input, init) => {
    const url = urlOf(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: parsed(raw),
      raw,
    });
    if (url.endsWith("/models")) return Promise.resolve(Response.json({ data: models }));
    const reply = replies[Math.min(next, replies.length - 1)] ?? completion();
    next += 1;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };
  return { fetch: fetchStub, requests };
}

/** OpenRouter's entry for Kimi K2.6 (2026-10): reasoning (no efforts listed), automatic caching. */
export const KIMI_ENTRY: StubModel = {
  id: "moonshotai/kimi-k2.6",
  supported_parameters: ["max_tokens", "reasoning", "temperature", "tools"],
  reasoning: { mandatory: false },
  pricing: { prompt: "0.0000004", completion: "0.0000018", input_cache_read: "0.00000007" },
};

/** Claude through OpenRouter: reasoning, explicit caching with a one-hour retention. */
export const CLAUDE_ENTRY: StubModel = {
  id: "anthropic/claude-sonnet-4.5",
  supported_parameters: ["max_tokens", "reasoning", "temperature", "tools"],
  reasoning: { mandatory: false },
  pricing: { prompt: "0.000003", input_cache_read: "0.0000003", input_cache_write_1h: "0.000006" },
};

/** GPT-5 through OpenRouter: mandatory reasoning, no temperature. */
export const GPT5_ENTRY: StubModel = {
  id: "openai/gpt-5",
  supported_parameters: ["max_tokens", "reasoning"],
  reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low", "minimal"] },
  pricing: { prompt: "0.00000125" },
};
