import { EventReader } from "../event-stream-lines.js";
import { failureOfStatus, ModelFailure } from "../model-failure.js";

/**
 * What a provider's server-sent events say (#1005): OpenAI-compatible `data: {…}` lines. A stream
 * is complete only when it said so (`[DONE]` or a `finish_reason`); an `{error}` inside an HTTP 200
 * is a failed call, never a success.
 */

/** One signal of the stream, in order. */
export type StreamSignal =
  | { readonly kind: "content" }
  | { readonly kind: "end" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly failure: ModelFailure | undefined;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CLIENT_ERROR =
  /invalid|unauthori|forbidden|not.?found|context.?length|bad.?request|permission/i;

/**
 * The failure an error object inside a 200 means: its `code` as an HTTP status (429 → rate limit),
 * or a code's name; a client error (400, 401, an invalid request) is no provider failure; any other
 * error is a server's.
 */
export function failureOfErrorObject(error: Record<string, unknown>): ModelFailure | undefined {
  const { code } = error;
  if (typeof code === "number") return failureOfStatus(code) ?? undefined;
  const name = typeof code === "string" ? code : "";
  if (/rate|too.?many|quota/i.test(name)) return ModelFailure.RateLimited;
  if (/timeout|timed.?out/i.test(name)) return ModelFailure.Timeout;
  return CLIENT_ERROR.test(name) ? undefined : ModelFailure.ServerError;
}

const CONTENT: StreamSignal = { kind: "content" };
const END: StreamSignal = { kind: "end" };

const hasText = (value: unknown): boolean => typeof value === "string" && value !== "";

/** Whether a choice's delta carries something the user is shown: text, a tool call, reasoning. */
function carriesContent(delta: unknown): boolean {
  if (!isRecord(delta)) return false;
  const { content, reasoning, reasoning_content: reasoningContent, tool_calls: calls } = delta;
  return (
    hasText(content) ||
    hasText(reasoning) ||
    hasText(reasoningContent) ||
    (Array.isArray(calls) && calls.length > 0) ||
    delta.function_call !== undefined
  );
}

/** The signals of one parsed event, in order; none for one that says nothing (a role, a usage chunk). */
function signalsOfEvent(event: unknown): StreamSignal[] {
  if (!isRecord(event)) return [];
  const { error, choices } = event;
  const list: unknown[] = Array.isArray(choices) ? choices : [];
  const finish = list.some(
    (choice) => isRecord(choice) && typeof choice.finish_reason === "string",
  );
  const failed = list.some((choice) => isRecord(choice) && choice.finish_reason === "error");
  if (isRecord(error) || failed) {
    const detail = isRecord(error) ? error : {};
    const message = typeof detail.message === "string" ? detail.message : "the stream failed";
    return [{ kind: "error", message, failure: failureOfErrorObject(detail) }];
  }
  const content = list.some((choice) => isRecord(choice) && carriesContent(choice.delta));
  return [...(content ? [CONTENT] : []), ...(finish ? [END] : [])];
}

/** The signals of one `data:` payload. */
function signalsOfData(payload: string): StreamSignal[] {
  if (payload === "[DONE]") return [END];
  try {
    return signalsOfEvent(JSON.parse(payload));
  } catch {
    return []; // not JSON: a keep-alive or a server's own line, says nothing
  }
}

/** Reads a stream's bytes as events: the signals of every complete event's payload (its `data:` lines joined, #1329), a partial one kept. */
export class EventScanner {
  readonly #events = new EventReader();
  readonly #decoder = new TextDecoder();
  /** The kind of the line being read: `undefined` until its first character. */
  #line: "comment" | "field" | undefined;
  #progressed = false;

  /**
   * Whether the last `push` carried more than the stream's own upkeep (#1125): any byte of a line
   * that is no `:` comment (a data line, even a partial one, a field) is progress; comments and
   * blank lines — what a proxy or a hung provider sends to keep a connection open — are not.
   */
  get progressed(): boolean {
    return this.#progressed;
  }

  /** The signals of what `bytes` completed. */
  push(bytes: Uint8Array): StreamSignal[] {
    const text = this.#decoder.decode(bytes, { stream: true });
    this.#progressed = this.#progressOf(text);
    return this.#events
      .push(text)
      .flatMap((event) => (event.data === undefined ? [] : signalsOfData(event.data.trim())));
  }

  #progressOf(text: string): boolean {
    let progressed = false;
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      const content = part.replace(/\r$/, "");
      if (content !== "") {
        this.#line ??= content.startsWith(":") ? "comment" : "field";
        if (this.#line === "field") progressed = true;
      }
      if (index < parts.length - 1) this.#line = undefined; // a newline ends the line
    });
    return progressed;
  }
}
