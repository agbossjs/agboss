import { describe, expect, it } from "vitest";
import { EventScanner } from "../../../src/models/calls/event-stream.js";
import { eventStreamOfJson, wantsStream } from "../../../src/models/calls/json-as-stream.js";

/** #1049: a plain completion told as the events of a stream. */

const json = (body: unknown, type = "application/json"): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": type, "content-length": "999" },
  });

const framesOf = async (response: Response): Promise<unknown[]> =>
  (await response.text())
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => {
      const data = frame.replace(/^data: /, "");
      return data === "[DONE]" ? data : (JSON.parse(data) as unknown);
    });

describe("wantsStream", () => {
  it.each([
    ['{"stream":true}', true],
    ['{"stream":false}', false],
    ['{"model":"m"}', false],
    ["[true]", false],
    ["not json", false],
  ])("a body %s asks for a stream: %s", (body, wanted) => {
    expect(wantsStream({ body })).toBe(wanted);
  });

  it("no body, or a body that is not a string, asks for none", () => {
    expect(wantsStream(undefined)).toBe(false);
    expect(wantsStream({})).toBe(false);
    expect(wantsStream({ body: new Uint8Array([1]) })).toBe(false);
  });
});

describe("eventStreamOfJson", () => {
  it("tells a tool call with its index, the finish reason and the usage, then [DONE]", async () => {
    const call = { id: "c1", type: "function", function: { name: "f", arguments: "{}" } };
    const response = await eventStreamOfJson(
      json({
        id: "x",
        provider: "Acme",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [call], reasoning: "think" },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.5 },
      }),
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.status).toBe(200);
    expect(await framesOf(response)).toEqual([
      {
        id: "x",
        provider: "Acme",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", tool_calls: [{ index: 0, ...call }], reasoning: "think" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "x",
        provider: "Acme",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      {
        id: "x",
        provider: "Acme",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.5 },
      },
      "[DONE]",
    ]);
  });

  it("a missing finish reason is a stop; a completion without usage tells none", async () => {
    const response = await eventStreamOfJson(
      json({ choices: [{ message: { content: "hi" } }, { index: 1, message: { content: "yo" } }] }),
    );

    const frames = await framesOf(response);
    expect(frames.map((frame) => JSON.stringify(frame))).toEqual([
      expect.stringContaining('"delta":{"role":"assistant","content":"hi"}'),
      expect.stringContaining('"finish_reason":"stop"'),
      expect.stringContaining('"index":1,"delta":{"role":"assistant","content":"yo"}'),
      expect.stringContaining('"index":1,"delta":{},"finish_reason":"stop"'),
      '"[DONE]"',
    ]);
  });

  it("the guard's scanner reads a completion as content, then the end", async () => {
    const response = await eventStreamOfJson(
      json({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    );

    const signals = new EventScanner().push(new TextEncoder().encode(await response.text()));

    expect(signals.map((signal) => signal.kind)).toEqual(["content", "end", "end"]);
  });

  it("an {error} is an error event; a string error becomes its message", async () => {
    const object = await framesOf(
      await eventStreamOfJson(json({ error: { code: 502, message: "m" } })),
    );
    const text = await framesOf(await eventStreamOfJson(json({ error: "overloaded" })));

    expect(object).toEqual([{ error: { code: 502, message: "m" } }, "[DONE]"]);
    expect(text).toEqual([{ error: { message: "overloaded" } }, "[DONE]"]);
  });

  it.each([
    ["an empty body", json("")],
    ["a JSON array", json("[]")],
    ["a JSON without choices", json({ choices: [] })],
    ["not JSON", json("<html>")],
    ["a null error with no choices", json({ error: null })],
    ["a text body", json("hello", "text/plain")],
  ])("%s is a failed call", async (_name, response) => {
    await expect(eventStreamOfJson(response)).rejects.toThrow(/no completion/);
  });
});
