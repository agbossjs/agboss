import { RawEvent, chunk, sseEvents, type SseScript } from "./sse-server.js";

/**
 * #1231: the shapes in which real providers send a streamed answer's usage. A provider reports it
 * once per call — the last report is the call's — and AGBoss must record exactly that, whatever
 * chunk carries it. `usage.cost` is OpenRouter's exact cost; `provider` names the host.
 */

/** One call's usage as the wire reports it (OpenRouter's fields). */
export type WireUsage = Readonly<Record<string, number>>;

export const WIRE_USAGE: WireUsage = {
  prompt_tokens: 120_000,
  completion_tokens: 30_000,
  total_tokens: 150_000,
  cost: 0.0421,
};

/** How a stream carries its usage. */
export enum UsageShape {
  /** OpenRouter: the last chunk has the finish choice (`delta: {content: ""}`) and the usage together. */
  OnFinishChoice = "usage on the finish chunk, beside its choice (OpenRouter)",
  /** OpenAI `stream_options.include_usage`: a finish chunk, then a usage chunk with `choices: []`. */
  OwnChunk = "usage in its own chunk with no choices after the finish (OpenAI include_usage)",
  /** Usage on several chunks, growing; the last report (a `choices: []` chunk) is the call's. */
  Repeated = "usage repeated on every chunk, the last report the call's",
  /** The same full usage on the finish chunk and again on a trailing `choices: []` chunk. */
  Twice = "the same usage on the finish chunk and on a trailing usage chunk",
}

const HOST = "Acme";

/** `usage` scaled to a share of the call (a running report before the last one). */
const share = (usage: WireUsage, part: number): WireUsage =>
  Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, value * part]));

const withUsage = (event: Record<string, unknown>, usage: WireUsage): Record<string, unknown> => ({
  ...event,
  usage,
});

const finish = (delta: Record<string, unknown>, reason = "stop"): Record<string, unknown> => ({
  ...chunk({}, HOST),
  choices: [{ index: 0, delta, finish_reason: reason }],
});

const usageChunk = (usage: WireUsage): Record<string, unknown> => ({
  id: "c",
  model: "m",
  provider: HOST,
  choices: [],
  usage,
});

/** The tokens' chunks; under `Repeated` each carries a growing share of the usage. */
function tokenEvents(tokens: readonly string[], shape: UsageShape, usage: WireUsage): unknown[] {
  return tokens.map((token, index) => {
    const event = chunk({ content: token }, HOST);
    return shape === UsageShape.Repeated
      ? withUsage(event, share(usage, (index + 1) / (tokens.length + 2)))
      : event;
  });
}

/** The chunks after the text: the finish and the usage, as `shape` sends them. */
function tailEvents(shape: UsageShape, usage: WireUsage, reason = "stop"): unknown[] {
  switch (shape) {
    case UsageShape.OnFinishChoice:
      return [withUsage(finish({ role: "assistant", content: "" }, reason), usage)];
    case UsageShape.OwnChunk:
      return [finish({}, reason), usageChunk(usage)];
    case UsageShape.Repeated:
      return [withUsage(finish({}, reason), share(usage, 0.9)), usageChunk(usage)];
    case UsageShape.Twice:
      return [withUsage(finish({}, reason), usage), usageChunk(usage)];
  }
}

/** A streamed answer of `tokens` whose usage comes in `shape`, then `[DONE]`. */
export function streamWithUsage(
  tokens: readonly string[],
  shape: UsageShape,
  usage: WireUsage = WIRE_USAGE,
): SseScript {
  return {
    steps: [
      sseEvents(chunk({ role: "assistant", content: "" }, HOST)),
      ...tokenEvents(tokens, shape, usage).map((event) => sseEvents(event)),
      sseEvents(...tailEvents(shape, usage), "[DONE]"),
    ],
  };
}

/**
 * A streamed tool call (#1231: a tool-bound agent's turn): the call's name, then its arguments in
 * two pieces, then the finish (`tool_calls`) and the usage as `shape` sends them, then `[DONE]`.
 */
export function streamedToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  shape: UsageShape,
  usage: WireUsage = WIRE_USAGE,
): SseScript {
  const text = JSON.stringify(args);
  const half = Math.floor(text.length / 2);
  const call = (piece: Record<string, unknown>): Record<string, unknown> =>
    chunk({ tool_calls: [{ index: 0, ...piece }] }, HOST);
  const pieces = [
    call({ id: "call-1", type: "function", function: { name, arguments: text.slice(0, half) } }),
    call({ function: { arguments: text.slice(half) } }),
  ];
  return {
    steps: [
      sseEvents(chunk({ role: "assistant", content: null }, HOST)),
      ...(shape === UsageShape.Repeated
        ? pieces.map((piece, index) => withUsage(piece, share(usage, (index + 1) / 4)))
        : pieces
      ).map((event) => sseEvents(event)),
      sseEvents(...tailEvents(shape, usage, "tool_calls"), "[DONE]"),
    ],
  };
}

/** The plain (not streamed) answer: the usage in the one response, the host beside it. */
export const plainWithUsage = (text: string, usage: WireUsage = WIRE_USAGE): unknown => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  provider: HOST,
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage,
});

export const WIRE_HOST = HOST;

/** The plain (not streamed) answer that is one tool call: `name` with `args`, the usage beside it. */
export const plainToolCallWithUsage = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  usage: WireUsage = WIRE_USAGE,
): unknown => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  provider: HOST,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage,
});

/**
 * One event whose JSON is cut over two `data:` lines, just before `before` (the SSE spec joins the
 * lines of an event with a newline: the payload is the same JSON; #1329), ended with `end`.
 */
export const splitEvent = (event: unknown, before: string, end = "\n\n"): RawEvent => {
  const json = JSON.stringify(event);
  const at = json.indexOf(`,"${before}"`) + 1;
  return new RawEvent(`data: ${json.slice(0, at)}\ndata: ${json.slice(at)}${end}`);
};

/** OpenRouter's stream whose last chunk (the finish choice with the usage) is cut over two `data:` lines (#1329). */
export function streamWithSplitUsage(
  tokens: readonly string[],
  usage: WireUsage = WIRE_USAGE,
): SseScript {
  return {
    steps: [
      sseEvents(chunk({ role: "assistant", content: "" }, HOST)),
      ...tokens.map((token) => sseEvents(chunk({ content: token }, HOST))),
      sseEvents(
        splitEvent(withUsage(finish({ role: "assistant", content: "" }), usage), "usage"),
        "[DONE]",
      ),
    ],
  };
}
