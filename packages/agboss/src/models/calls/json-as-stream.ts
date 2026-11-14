import { EventStreamError } from "./event-stream-guard.js";

/**
 * A streamed request answered with something else than server-sent events (#1049). Some
 * OpenAI-compatible servers and proxies ignore `stream: true` and answer a plain JSON completion:
 * it is the call's answer — re-told as the events of one chunk (one delta, the finish reason, the
 * exact usage) so the client and the guard read it as they read any stream. An `{error}` in the
 * body stays an error event; an empty body, another content type or a JSON that is no completion
 * is a failed call (`EventStreamError`), never a success without an answer.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a request asks for a stream (its JSON body says `stream: true`). */
export function wantsStream(init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.stream === true;
  } catch {
    return false;
  }
}

/** A message's fields as a streamed delta: tool calls carry their `index`. */
function deltaOf(message: Record<string, unknown>): Record<string, unknown> {
  const { tool_calls: calls, content, role, ...rest } = message;
  const delta: Record<string, unknown> = {
    ...rest,
    role: typeof role === "string" ? role : "assistant",
  };
  if (typeof content === "string") delta.content = content;
  if (Array.isArray(calls))
    delta.tool_calls = calls.map((call, index) => ({ index, ...(isRecord(call) ? call : {}) }));
  return delta;
}

/** What a chunk does not repeat of the completion. */
const OMITTED: ReadonlySet<string> = new Set(["choices", "usage", "object"]);

/** The chunks that tell a completion's choices, then its usage. */
function chunksOf(completion: Record<string, unknown>, choices: readonly unknown[]): unknown[] {
  const { usage } = completion;
  const base = {
    ...Object.fromEntries(Object.entries(completion).filter(([key]) => !OMITTED.has(key))),
    object: "chat.completion.chunk",
  };
  const told = choices.flatMap((choice) => {
    if (!isRecord(choice)) return [];
    const index = typeof choice.index === "number" ? choice.index : 0;
    const message = isRecord(choice.message) ? choice.message : {};
    const reason = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
    return [
      { ...base, choices: [{ index, delta: deltaOf(message), finish_reason: null }] },
      { ...base, choices: [{ index, delta: {}, finish_reason: reason }] },
    ];
  });
  return isRecord(usage) ? [...told, { ...base, choices: [], usage }] : told;
}

/** The error of a body as an error event. */
function errorEvent(error: unknown): unknown {
  return { error: isRecord(error) ? error : { message: String(error) } };
}

/** The events a JSON body is told as, or `undefined` when it is no completion and no error. */
function eventsOfJson(parsed: unknown): unknown[] | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.error !== undefined && parsed.error !== null) return [errorEvent(parsed.error)];
  const { choices } = parsed;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return chunksOf(parsed, choices);
}

const asEvents = (events: readonly unknown[]): string =>
  [...events, "[DONE]"]
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");

/**
 * A `200` answer to a streamed request that is not an event stream, as an event stream.
 * @throws EventStreamError when it is no completion.
 */
export async function eventStreamOfJson(response: Response): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  const text = type.includes("json") ? await response.text() : "";
  if (!type.includes("json")) await response.body?.cancel();
  let events: unknown[] | undefined;
  try {
    events = eventsOfJson(JSON.parse(text));
  } catch {
    events = undefined;
  }
  if (events === undefined) {
    throw new EventStreamError("the server answered a streamed request with no completion");
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(asEvents(events), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
