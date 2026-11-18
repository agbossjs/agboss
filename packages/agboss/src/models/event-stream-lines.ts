/**
 * A server-sent-events body rewritten line by line, as the chat client's fetch reads it: a line may
 * span chunks of the body, and is rewritten only once it is whole.
 */

/** How one body is rewritten: each whole line, and what is added when the body ends. */
export interface LineRewrite {
  /** The text that takes `line`'s place (without its newline; it may hold several lines). */
  line(line: string): string;
  /** What the body ends with, after its last line (`""`: nothing). */
  end(): string;
}

/** `body` with every line rewritten by `rewrite`. */
export function rewrittenLines(
  body: ReadableStream<Uint8Array>,
  rewrite: LineRewrite,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        // Stryker disable next-line StringLiteral: `split` gives one part at least — never taken
        pending = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(encoder.encode(`${rewrite.line(line)}\n`));
      },
      flush(controller) {
        pending += decoder.decode();
        const last = pending === "" ? [] : [rewrite.line(pending)];
        const end = rewrite.end();
        // a body cut without its last newline: what the end adds is an event of its own
        controller.enqueue(encoder.encode([...last, ...(end === "" ? [] : [end])].join("\n\n")));
      },
    }),
  );
}

/**
 * The answer with its body rewritten when it is a stream of events; an error, an empty body or any
 * other answer as it is. The body's length and encoding headers no longer describe it: they go.
 */
export function withRewrittenEvents(response: Response, rewrite: () => LineRewrite): Response {
  const type = response.headers.get("content-type");
  if (!response.ok || response.body === null || type === null) return response;
  if (!type.includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewrittenLines(response.body, rewrite()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
