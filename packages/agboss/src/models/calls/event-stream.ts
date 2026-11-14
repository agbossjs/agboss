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

/** Reads a stream's bytes as events: the signals of every complete `data:` line, a partial line kept. */
export class EventScanner {
  #pending = "";
  readonly #decoder = new TextDecoder();

  /** The signals of what `bytes` completed. */
  push(bytes: Uint8Array): StreamSignal[] {
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    return lines.flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      return signalsOfData(line.slice("data:".length).trim());
    });
  }
}
