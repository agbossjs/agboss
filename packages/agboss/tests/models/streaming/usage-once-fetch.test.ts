import { describe, expect, it } from "vitest";
import { usageOnceFetch } from "../../../src/models/usage-once.js";

/**
 * #1231: the client's fetch hands the client a stream with one usage report — the provider's last,
 * in a chunk of its own with no choice, before `[DONE]` — whatever chunks carried it; anything
 * else of the answer as it came.
 */

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };

/** A fetch that answers `parts` (the body's chunks, as the network cuts them) with `init`. */
const answering =
  (parts: readonly (string | Uint8Array)[], init: ResponseInit = {}): typeof fetch =>
  () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts)
          controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "content-length": "999" },
        ...init,
      }),
    );
  };

async function bodyOf(parts: readonly (string | Uint8Array)[], init?: ResponseInit) {
  const response = await usageOnceFetch(answering(parts, init))("http://127.0.0.1/v1");
  return { response, text: await response.text() };
}

/** The `data:` payloads of an event-stream body, parsed where they are JSON. */
const eventsOf = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .map((payload): unknown => (payload.startsWith("{") ? JSON.parse(payload) : payload));

const data = (event: unknown): string =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;

const choice = (content: string, finish: string | null = null) => ({
  index: 0,
  delta: { content },
  finish_reason: finish,
});

describe("#1231: usageOnceFetch", () => {
  it("usage beside the finish choice (OpenRouter): the choice without it, then one usage chunk, then [DONE]", async () => {
    const { text } = await bodyOf([
      data({ id: "g", provider: "Acme", choices: [choice("Hi")] }),
      data({ id: "g", provider: "Acme", choices: [choice("", "stop")], usage: USAGE }),
      data("[DONE]"),
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", provider: "Acme", choices: [choice("Hi")] },
      { id: "g", provider: "Acme", choices: [choice("", "stop")] },
      { id: "g", provider: "Acme", choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("usage on several chunks: only the last report is kept, once", async () => {
    const early = { ...USAGE, cost: 0.0004 };
    const { text } = await bodyOf([
      data({ id: "g", choices: [choice("Hi")], usage: early }),
      data({ id: "g", choices: [choice("", "stop")], usage: USAGE }),
      data({ id: "g", choices: [], usage: USAGE }),
      data("[DONE]"),
    ]);

    const events = eventsOf(text);
    const reports = events.filter(
      (event) => typeof event === "object" && event !== null && "usage" in event,
    );
    expect(reports).toEqual([{ id: "g", choices: [], usage: USAGE }]);
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("a `usage: null` (OpenAI on every chunk) is dropped and reports nothing", async () => {
    const { text } = await bodyOf([
      data({ id: "g", choices: [choice("Hi")], usage: null }),
      data({ id: "g", choices: [choice("", "stop")], usage: null }),
      data("[DONE]"),
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [choice("Hi")] },
      { id: "g", choices: [choice("", "stop")] },
      "[DONE]",
    ]);
  });

  it("lines cut across chunks of the body are rewritten whole", async () => {
    const line = data({ id: "g", choices: [choice("", "stop")], usage: USAGE });
    const { text } = await bodyOf([
      line.slice(0, 17),
      line.slice(17, 40),
      line.slice(40),
      "data: [DO",
      "NE]\n\n",
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [choice("", "stop")] },
      { id: "g", choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("a body that ends without [DONE] gives its usage at the end", async () => {
    const { text } = await bodyOf([
      data({ id: "g", choices: [choice("Hi", "stop")], usage: USAGE }),
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [choice("Hi", "stop")] },
      { id: "g", choices: [], usage: USAGE },
    ]);
  });

  it("a body cut without its last newline: its last line and the usage stay two events", async () => {
    const { text } = await bodyOf([
      `data: ${JSON.stringify({ id: "g", choices: [choice("Hi", "stop")], usage: USAGE })}`,
    ]);

    expect(text.split("\n\n").filter((part) => part !== "")).toHaveLength(2);
    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [choice("Hi", "stop")] },
      { id: "g", choices: [], usage: USAGE },
    ]);
  });

  it("a [DONE] with no usage before it, CRLF line ends, comments and lines that are no JSON pass as they are", async () => {
    const parts = [
      ": OPENROUTER PROCESSING\r\n\r\n",
      "data: not json\n\n",
      "event: ping\n\n",
      "data: [DONE]\r\n\r\n",
    ];
    const { text } = await bodyOf(parts);

    expect(text).toBe(parts.join(""));
  });

  it("a usage chunk before [DONE] with CRLF line ends is moved, its [DONE] kept", async () => {
    const { text } = await bodyOf([
      `data: ${JSON.stringify({ id: "g", choices: [choice("", "stop")], usage: USAGE })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [choice("", "stop")] },
      { id: "g", choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("the rewritten answer keeps its status and headers, but no length or encoding", async () => {
    const { response } = await bodyOf([data("[DONE]")], {
      headers: {
        "content-type": "text/event-stream",
        "content-length": "13",
        "content-encoding": "gzip",
        "x-request-id": "r1",
      },
      statusText: "Fine",
    });

    expect(response.status).toBe(200);
    expect(response.statusText).toBe("Fine");
    expect(response.headers.get("x-request-id")).toBe("r1");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it.each([
    ["a JSON answer", { headers: { "content-type": "application/json", "content-length": "5" } }],
    [
      "an error",
      { status: 500, headers: { "content-type": "text/event-stream", "content-length": "5" } },
    ],
    ["an answer of no type", { headers: { "content-length": "5" } }],
  ])("%s is the answer as it came, its headers too", async (_name, init) => {
    const original = JSON.stringify({ choices: [choice("", "stop")], usage: USAGE });
    const { response, text } = await bodyOf([original], init);

    expect(text).toBe(original);
    expect(response.headers.get("content-length")).toBe("5");
  });

  it("an answer without a body is the answer as it came", async () => {
    const empty: typeof fetch = () =>
      Promise.resolve(
        new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } }),
      );

    const response = await usageOnceFetch(empty)("http://127.0.0.1/v1");

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
  it("a body that reports no usage and ends without [DONE] or a last newline is the body as it came", async () => {
    const parts = [data({ id: "g", choices: [choice("Hi", "stop")] }), "data: [DONE]"];
    const { text } = await bodyOf(parts);

    expect(text).toBe(parts.join(""));
  });

  it("a body that ends without [DONE] but with its newline: the usage chunk follows, no blank event before it", async () => {
    const { text } = await bodyOf([
      data({ id: "g", choices: [choice("Hi", "stop")], usage: USAGE }),
    ]);

    expect(text).toBe(
      data({ id: "g", choices: [choice("Hi", "stop")] }) +
        data({ id: "g", choices: [], usage: USAGE }),
    );
  });

  it("a character cut across chunks of the body comes out whole", async () => {
    const bytes = new TextEncoder().encode(data({ id: "g", choices: [choice("café ünï")] }));
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "é"

    const { text } = await bodyOf([bytes.slice(0, cut), bytes.slice(cut), data("[DONE]")]);

    expect(eventsOf(text)).toEqual([{ id: "g", choices: [choice("café ünï")] }, "[DONE]"]);
  });

  it("a chunk without usage, a JSON value that is no object and a comment are passed byte for byte", async () => {
    const parts = [
      'data: {"id": "g",  "choices": [{"index": 0, "delta": {"content": "Hi"}}]}\n\n',
      "data: [1, 2]\n\n",
      "data: 42\n\n",
      'data: "text"\n\n',
      "data: null\n\n",
      ':abcd{"usage":{"cost":1}}\n\n',
      "data: [DONE]\n\n",
    ];
    const { text } = await bodyOf(parts);

    expect(text).toBe(parts.join(""));
  });
});
