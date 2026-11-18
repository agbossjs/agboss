/**
 * A server-sent-events body rewritten event by event, as the chat client's fetch reads it. An event
 * is the lines up to a blank line (`\n`, `\r\n` or `\r` end a line), and its `data:` lines are one
 * payload, joined with `\n` (the SSE spec): a provider may cut one JSON over several of them (#1329).
 * An event is rewritten only once it is whole, though a chunk of the body may cut it anywhere.
 */

/** What takes the place of an event's payload: one event per text (at least one). */
export type Replacement = readonly [string, ...string[]];

/** How one body is rewritten: each event's payload, and what is added when the body ends. */
export interface EventRewrite {
  /** The payloads that take the place of an event's (`undefined`: the event as it is). */
  data(payload: string): Replacement | undefined;
  /** The payloads the body ends with, after its last event (none: nothing). */
  end(): readonly string[];
}

/** A line with the terminator that ends it. */
const LINE = /[^\r\n]*(?:\r\n|\n|\r)/y;

const isData = (line: string): boolean => line === "data" || line.startsWith("data:");

/** A `data` line's value: after its colon, one space dropped (the SSE spec). */
const valueOf = (line: string): string => line.slice("data:".length).replace(/^ /, "");

/** One event of a body: its text as it came, its lines, and its payload. */
export interface ParsedEvent {
  /** The event as it came, with its line ends (and its blank line, when it came). */
  readonly raw: string;
  /** Its lines without their ends (`event:`, `id:`, a `:` comment, `data:`). */
  readonly lines: readonly string[];
  /** Its `data:` lines' values joined with `\n`; `undefined` when it has none. */
  readonly data: string | undefined;
  /** Whether its blank line came: a body may end before it. */
  readonly ended: boolean;
}

/**
 * The events of a body, read from the text of its chunks as they come: a line, and an event, may
 * be cut by a chunk anywhere. The one reader of the events (#1329): what rewrites a body and what
 * scans it for its signals agree on what an event is.
 */
export class EventReader {
  #pending = "";
  #raw = "";
  #lines: string[] = [];

  /** The events `text` completed (each ended by its blank line). */
  push(text: string): ParsedEvent[] {
    this.#pending += text;
    return this.#read(false);
  }

  /** What the body's end completes: the last line, whose end may be a `\r` that waited; its event, cut when it has no blank line. */
  finish(): ParsedEvent | undefined {
    // what is pending is one line at most: it is read to its end, whatever that is
    const [ended] = this.#read(true);
    if (ended !== undefined) return ended;
    this.#raw += this.#pending;
    if (this.#pending !== "") this.#lines.push(this.#pending);
    this.#pending = "";
    return this.#lines.length === 0 ? undefined : this.#take(false);
  }

  #read(last: boolean): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    let at = 0;
    for (;;) {
      LINE.lastIndex = at;
      const line = LINE.exec(this.#pending);
      if (line === null) break;
      const [whole] = line;
      // a `\r` that ends the text may be the first half of a `\r\n`
      if (!last && whole.endsWith("\r") && at + whole.length === this.#pending.length) break;
      at += whole.length;
      this.#raw += whole;
      // Stryker disable next-line Regex: a line holds no line end before its own, the first run is the last
      const content = whole.replace(/[\r\n]+$/, "");
      if (content === "") events.push(this.#take(true));
      else this.#lines.push(content);
    }
    this.#pending = this.#pending.slice(at);
    return events;
  }

  #take(ended: boolean): ParsedEvent {
    const data = this.#lines.filter(isData).map(valueOf);
    const event = {
      raw: this.#raw,
      lines: this.#lines,
      data: data.length === 0 ? undefined : data.join("\n"),
      ended,
    };
    this.#raw = "";
    this.#lines = [];
    return event;
  }
}

/** An event of the lines `others` (`event:`, `id:`, comments) and the `data:` lines of `payload`. */
const eventOf = (payload: string, others: readonly string[]): string =>
  [...others, ...payload.split("\n").map((value) => `data: ${value}`)].join("\n");

/** `body` with every event rewritten by `rewrite`. */
export function rewrittenEvents(
  body: ReadableStream<Uint8Array>,
  rewrite: EventRewrite,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = new EventReader();

  /** The event as it came, or rewritten. */
  const dispatch = (event: ParsedEvent): string => {
    const replaced = event.data === undefined ? undefined : rewrite.data(event.data);
    if (replaced === undefined) return event.raw;
    const others = event.lines.filter((line) => !isData(line));
    const events = replaced.map((payload, at) =>
      eventOf(payload, at === replaced.length - 1 ? others : []),
    );
    return events.join("\n\n") + (event.ended ? "\n\n" : "");
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const events = reader.push(decoder.decode(chunk, { stream: true }));
        controller.enqueue(encoder.encode(events.map(dispatch).join("")));
      },
      flush(controller) {
        // a character cut at the body's end comes out as the replacement character, in a line of its own
        reader.push(decoder.decode());
        const cut = reader.finish();
        const last = cut === undefined ? "" : dispatch(cut);
        const ending = rewrite.end().map((payload) => eventOf(payload, []));
        // an event cut before its last blank line is an event of its own, ended before what the end adds
        const apart = cut?.ended === false ? "\n\n" : "";
        const tail = ending.length === 0 ? "" : `${apart}${ending.join("\n\n")}\n\n`;
        controller.enqueue(encoder.encode(last + tail));
      },
    }),
  );
}

/**
 * The answer with its body rewritten when it is a stream of events; an error, an empty body or any
 * other answer as it is. The body's length and encoding headers no longer describe it: they go.
 */
export function withRewrittenEvents(response: Response, rewrite: () => EventRewrite): Response {
  const type = response.headers.get("content-type");
  if (!response.ok || response.body === null || type === null) return response;
  if (!type.includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewrittenEvents(response.body, rewrite()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
