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

describe("#1329: usageOnceFetch reads an event, not a line", () => {
  const report = { id: "g", provider: "Acme", choices: [choice("", "stop")], usage: USAGE };
  /** The event's JSON cut over two `data:` lines, just before its `usage`. */
  const cutOver = (end: string): string => {
    const json = JSON.stringify(report);
    const at = json.indexOf(',"usage"') + 1;
    return `data: ${json.slice(0, at)}${end}data: ${json.slice(at)}${end}${end}`;
  };
  const expected = [
    { id: "g", provider: "Acme", choices: [choice("", "stop")] },
    { id: "g", provider: "Acme", choices: [], usage: USAGE },
    "[DONE]",
  ];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("a usage event cut over two data lines (%s) gives its usage once", async (_name, end) => {
    const { text } = await bodyOf([cutOver(end), `data: [DONE]${end}${end}`]);

    expect(eventsOf(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))).toEqual(expected);
    expect(text.split('"usage"')).toHaveLength(2);
  });

  it("the cut event is the same event wherever the body's chunks cut it", async () => {
    const whole = `${cutOver("\r\n")}data: [DONE]\r\n\r\n`;
    for (let cut = 1; cut < whole.length; cut += 1) {
      const { text } = await bodyOf([whole.slice(0, cut), whole.slice(cut)]);

      expect(eventsOf(text.replaceAll("\r\n", "\n"))).toEqual(expected);
    }
  });

  it("a cut event with no blank line at the end of the body gives its usage, once, after it", async () => {
    const { text } = await bodyOf([cutOver("\n").slice(0, -1)]);

    expect(text.split("\n\n").filter((part) => part !== "")).toHaveLength(2);
    expect(eventsOf(text)).toEqual(expected.slice(0, 2));
  });

  it("a [DONE] with fields of its own keeps them, after the usage that comes before it", async () => {
    const { text } = await bodyOf([cutOver("\n"), "event: done\ndata: [DONE]\n\n"]);

    expect(eventsOf(text)).toEqual(expected);
    expect(text.endsWith("\n\nevent: done\ndata: [DONE]\n\n")).toBe(true);
  });

  it("two data lines that join to `[DO\\nNE]` are no [DONE]: the usage waits for the body's end", async () => {
    const { text } = await bodyOf([cutOver("\n"), "data: [DO\ndata: NE]\n\n"]);

    expect(text).toBe(data(expected[0]) + "data: [DO\ndata: NE]\n\n" + data(expected[1]));
  });

  it("a payload that is no JSON, cut or not, passes as it came", async () => {
    const parts = [
      "data: not\ndata: json\n\n",
      'data: {"usage":\ndata: {broken}\n\n',
      "data: [DONE]\n\n",
    ];
    const { text } = await bodyOf(parts);

    expect(text).toBe(parts.join(""));
  });
});

describe("#1329: a last event cut mid-JSON, with no blank line, is no usage", () => {
  it("it passes as it came and records nothing; the usage held before it still comes, once, after", async () => {
    const full = data({ id: "g", choices: [choice("", "stop")], usage: USAGE });
    const cut = 'data: {"id": "g", "choices": [],\ndata: "usage": {"cost": 0.5, "prompt_to';

    const { text } = await bodyOf([full, cut]);

    expect(text).toBe(
      data({ id: "g", choices: [choice("", "stop")] }) +
        cut +
        "\n\n" +
        data({ id: "g", choices: [], usage: USAGE }),
    );
  });

  it("with no usage before it, the body is the body as it came", async () => {
    const parts = [data({ id: "g", choices: [choice("Hi")] }), 'data: {"usage":\ndata: {"cost": 1'];

    expect((await bodyOf(parts)).text).toBe(parts.join(""));
  });

  it("the same event, whole, is read: its usage is the call's", async () => {
    const { text } = await bodyOf([
      'data: {"id": "g", "choices": [],\ndata: "usage": {"cost": 0.5}}',
    ]);

    expect(eventsOf(text)).toEqual([
      { id: "g", choices: [] },
      { id: "g", choices: [], usage: { cost: 0.5 } },
    ]);
  });
});

describe("#1329: several events in one chunk, blanks around [DONE]", () => {
  it("events that come in one chunk go out in order, each ended", async () => {
    const chunk = `${data({ id: "g", choices: [choice("a")], usage: USAGE })}: note\n\n${data("[DONE]")}`;

    const { text } = await bodyOf([chunk]);

    expect(text).toBe(
      data({ id: "g", choices: [choice("a")] }) +
        ": note\n\n" +
        data({ id: "g", choices: [], usage: USAGE }) +
        data("[DONE]"),
    );
  });

  it("a [DONE] with blanks after it is a [DONE], as the client reads it", async () => {
    const { text } = await bodyOf([
      data({ id: "g", choices: [choice("", "stop")], usage: USAGE }),
      "data: [DONE]  \n\n",
    ]);

    expect(text).toBe(
      data({ id: "g", choices: [choice("", "stop")] }) +
        data({ id: "g", choices: [], usage: USAGE }) +
        "data: [DONE]  \n\n",
    );
  });
});

describe("#1329: the body's last event is ended by a `\\r` that waited", () => {
  it("a usage event ended by a last lone CR gives its usage once after it, no blank event between", async () => {
    const event = JSON.stringify({ id: "g", choices: [choice("", "stop")], usage: USAGE });

    const { text } = await bodyOf([`data: ${event}\r\r`]);

    expect(text).toBe(
      data({ id: "g", choices: [choice("", "stop")] }) +
        data({ id: "g", choices: [], usage: USAGE }),
    );
  });
});

describe("#1329: a character cut at the body's very end", () => {
  it("comes out as the replacement character, in the event it ended", async () => {
    const bytes = new TextEncoder().encode("data: é");

    const { text } = await bodyOf([bytes.slice(0, bytes.length - 1)]);

    expect(text).toBe("data: �");
  });

  it("[DONE] is the payload as it is: with a second space before it, it is no [DONE] and the usage waits for the end", async () => {
    const { text } = await bodyOf([
      data({ id: "c1", choices: [choice("a")], usage: USAGE }),
      "data:  [DONE]\n\n",
    ]);

    // the line is passed as it came; the usage is given after it, at the body's end
    expect(text.indexOf("data:  [DONE]")).toBeLessThan(text.indexOf('"usage"'));
  });
});
