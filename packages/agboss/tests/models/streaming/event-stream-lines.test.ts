import { describe, expect, it } from "vitest";
import {
  EventReader,
  EventTooLargeError,
  MAX_EVENT_BYTES,
  rewrittenEvents,
} from "../../../src/models/event-stream-lines.js";

/**
 * #1329: an event of a server-sent-events body is its lines up to a blank line, and its `data:`
 * lines are one payload joined with a newline — whatever the line ends, and wherever the body's
 * chunks cut it.
 */

const read = (...parts: string[]) => {
  const reader = new EventReader();
  const events = parts.flatMap((part) => reader.push(part));
  const last = reader.finish();
  return { events, left: last === undefined ? [] : [last] };
};

describe("#1329: the event reader", () => {
  it("the data lines of one event are one payload, joined with a newline", () => {
    const { events } = read('data: {"a":1,\ndata: "b":2}\n\n');

    expect(events).toEqual([
      {
        raw: 'data: {"a":1,\ndata: "b":2}\n\n',
        lines: ['data: {"a":1,', 'data: "b":2}'],
        data: '{"a":1,\n"b":2}',
        ended: true,
      },
    ]);
  });

  it("one space after the colon is dropped, no more; `data` alone is an empty line; other fields are no data", () => {
    const { events } = read("data:  x\ndata:y\ndata\nevent: e\nid: 1\n: note\n\n");

    expect(events[0]?.data).toBe(" x\ny\n");
    expect(events[0]?.lines).toEqual(["data:  x", "data:y", "data", "event: e", "id: 1", ": note"]);
  });

  it("only the one space after the colon goes, wherever a space is", () => {
    expect(read("data:x y\n\n").events[0]?.data).toBe("x y");
    expect(read("data: x y\n\n").events[0]?.data).toBe("x y");
  });

  it("an event without a data line has no payload", () => {
    const { events } = read(": keep-alive\n\nevent: ping\n\n");

    expect(events.map((event) => event.data)).toEqual([undefined, undefined]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("%s ends the lines and the event, and is kept in the raw text", (_name, end) => {
    const text = `data: a${end}data: b${end}${end}data: c${end}${end}`;
    const { events, left } = read(text);

    expect(events.concat(left).map((event) => event.data)).toEqual(["a\nb", "c"]);
    expect(
      events
        .concat(left)
        .map((event) => event.raw)
        .join(""),
    ).toBe(text);
  });

  it("a blank line with no event before it is an event of no lines", () => {
    const { events } = read("\n\ndata: a\n\n");

    expect(events.map((event) => event.lines)).toEqual([[], [], ["data: a"]]);
  });

  it("an event cut by the text anywhere — also inside a `\\r\\n` — is the same event", () => {
    const text = "data: ab\r\ndata: cd\r\n\r\ndata: e\r\n\r\n";
    for (let cut = 0; cut <= text.length; cut += 1) {
      const { events } = read(text.slice(0, cut), text.slice(cut));

      expect(events.map((event) => event.data)).toEqual(["ab\ncd", "e"]);
      expect(events.map((event) => event.raw).join("")).toBe(text);
    }
  });

  it("a `\\r` that ends the text waits for what follows: `\\n` is one line end with it, anything else a line end of its own", () => {
    const reader = new EventReader();

    expect(reader.push("data: a\r")).toEqual([]);
    expect(reader.push("\r")).toEqual([]);
    expect(reader.push("data: b")).toHaveLength(1);
    expect(reader.push("\r")).toEqual([]);
    expect(reader.push("\n\r\n")).toHaveLength(1);
  });

  it("the body's end ends a last `\\r` line; an event left without its blank line is cut, nothing when none is", () => {
    expect(read("data: a\n\n").left).toEqual([]);
    expect(read("data: a\ndata: b").left).toEqual([
      { raw: "data: a\ndata: b", lines: ["data: a", "data: b"], data: "a\nb", ended: false },
    ]);
    expect(read("data: a\n").left.map((event) => event.data)).toEqual(["a"]);
    expect(read("data: a\r\r").left).toEqual([
      { raw: "data: a\r\r", lines: ["data: a"], data: "a", ended: true },
    ]);
    expect(read("data: a\r").left).toEqual([
      { raw: "data: a\r", lines: ["data: a"], data: "a", ended: false },
    ]);
  });

  it("an event is taken once: the reader starts the next from nothing", () => {
    const reader = new EventReader();
    reader.push("data: a\n\n");

    expect(reader.finish()).toBeUndefined();
    expect(reader.push("data: b\n\n")[0]?.raw).toBe("data: b\n\n");
  });
});

const streamOf = (...parts: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

const textOf = (body: ReadableStream<Uint8Array>): Promise<string> => new Response(body).text();

describe("#1329: a body rewritten by event", () => {
  const upper = {
    data: (payload: string) =>
      payload === "skip" ? undefined : ([payload.toUpperCase()] as const),
    end: () => [],
  };

  it("an event is rewritten from its whole payload, the other fields of it kept", async () => {
    const text = await textOf(
      rewrittenEvents(streamOf("event: m\nid: 7\ndata: ab\ndata: cd\n\n"), upper),
    );

    expect(text).toBe("event: m\nid: 7\ndata: AB\ndata: CD\n\n");
  });

  it("an event the rewrite leaves is the bytes it came as, line ends too", async () => {
    const text = ": hi\r\n\r\ndata: skip\r\n\r\nevent: x\n\n";

    expect(await textOf(rewrittenEvents(streamOf(text), upper))).toBe(text);
  });

  it("several payloads take the place of one event, each its own event, the other fields on the last", async () => {
    const text = await textOf(
      rewrittenEvents(streamOf("event: m\ndata: a\n\n"), {
        data: () => ["one", "two\nlines"],
        end: () => [],
      }),
    );

    expect(text).toBe("data: one\n\nevent: m\ndata: two\ndata: lines\n\n");
  });

  it("what the end adds is events after the last one, each ended by a blank line", async () => {
    const ended = { data: () => undefined, end: () => ["x", "y"] };

    expect(await textOf(rewrittenEvents(streamOf("data: a\n\n"), ended))).toBe(
      "data: a\n\ndata: x\n\ndata: y\n\n",
    );
    expect(await textOf(rewrittenEvents(streamOf(), ended))).toBe("data: x\n\ndata: y\n\n");
  });

  it("an event cut before its blank line is an event of its own, the end after it", async () => {
    const replaced = { data: (payload: string) => [`<${payload}>`] as const, end: () => ["end"] };

    expect(await textOf(rewrittenEvents(streamOf("data: a\ndata: b"), replaced))).toBe(
      "data: <a\ndata: b>\n\ndata: end\n\n",
    );
    expect(await textOf(rewrittenEvents(streamOf("data: a\ndata: b"), upper))).toBe(
      "data: A\ndata: B",
    );
    expect(await textOf(rewrittenEvents(streamOf("data: skip"), upper))).toBe("data: skip");
  });

  it("an event whose last bytes wait in the decoder when the body ends comes out whole", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n");
    const cut = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut, bytes.length - 2));
        controller.enqueue(bytes.slice(bytes.length - 2));
        controller.close();
      },
    });

    expect(await textOf(rewrittenEvents(body, upper))).toBe("data: É\n\n");
  });

  it("an event is given as it is whole, not before: a chunk cuts it where it likes", async () => {
    const text = "data: ab\r\ndata: cd\r\n\r\n";
    for (let cut = 1; cut < text.length; cut += 1) {
      const out = await textOf(
        rewrittenEvents(streamOf(text.slice(0, cut), text.slice(cut)), upper),
      );

      expect(out).toBe("data: AB\ndata: CD\n\n");
    }
  });
});

describe("the bytes buffered for one event are bounded", () => {
  const line = `data: ${"x".repeat(1019)}\n`; // 1,026 bytes

  it("an event up to MAX_EVENT_BYTES is read; one byte more fails with the typed error, no text in it", () => {
    const fits = new EventReader();
    // exactly MAX_EVENT_BYTES: `data: ` (6), the value, and its line end (1)
    expect(fits.push(`data: ${"a".repeat(MAX_EVENT_BYTES - 7)}\n`)).toEqual([]);
    expect(fits.push("\n")[0]?.ended).toBe(true);

    const over = new EventReader();
    expect(over.push(`data: ${"SECRET".repeat(100)}\n`)).toEqual([]);
    let failure: unknown;
    try {
      for (let held = 0; held <= MAX_EVENT_BYTES; held += line.length) over.push(line);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EventTooLargeError);
    expect((failure as Error).name).toBe("EventTooLargeError");
    expect((failure as Error).message).toBe(
      `a streamed event is larger than ${String(MAX_EVENT_BYTES)} bytes`,
    );
    expect((failure as Error).message).not.toContain("SECRET");
  });

  it("one line with no end counts too, and bytes count, not characters", () => {
    expect(() => new EventReader().push("data: " + "é".repeat(MAX_EVENT_BYTES / 2))).toThrow(
      EventTooLargeError,
    );
    expect(() => new EventReader().push("data: " + "a".repeat(MAX_EVENT_BYTES))).toThrow(
      EventTooLargeError,
    );
  });

  it("events that end are not held: a body of many events is no more than its biggest", () => {
    const reader = new EventReader();
    const one = `data: ${"y".repeat(1_000_000)}\n\n`;
    for (let at = 0; at < 40; at += 1) expect(reader.push(one)).toHaveLength(1);
    // what follows an event's blank line in the same text counts for the next event
    expect(reader.push(`${one}data: ${"z".repeat(MAX_EVENT_BYTES - 100)}`)).toHaveLength(1);
  });

  it("what waits after an event that ended in the same text counts for the next one", () => {
    const reader = new EventReader();

    expect(() => reader.push(`data: a\n\ndata: ${"x".repeat(MAX_EVENT_BYTES)}`)).toThrow(
      EventTooLargeError,
    );
  });

  it("one byte past the bound fails where the bound itself is read", () => {
    expect(() => new EventReader().push(`data: ${"a".repeat(MAX_EVENT_BYTES - 6)}`)).not.toThrow();
    expect(() => new EventReader().push(`data: ${"a".repeat(MAX_EVENT_BYTES - 5)}`)).toThrow(
      EventTooLargeError,
    );
  });

  it("a rewritten body fails with the typed error, as the stream's own", async () => {
    const body = streamOf(`data: ${"q".repeat(MAX_EVENT_BYTES + 1)}`);

    await expect(
      textOf(rewrittenEvents(body, { data: () => undefined, end: () => [] })),
    ).rejects.toBeInstanceOf(EventTooLargeError);
  });
});
