/**
 * Which host served a call (#395 PR 6): OpenRouter names it in every completion (`provider`, a JSON
 * answer or each streamed chunk), but the chat client keeps only the answer's `usage`. This fetch
 * copies the host into that `usage` as `SERVED_BY_FIELD`, which `recordUsage` reads as
 * `UsageRecord.servedBy` — for a plain and for a streamed answer alike.
 */

import { SERVED_BY_FIELD } from "../finops/served-by.js";
import { rewrittenEvents, type Replacement } from "./event-stream-lines.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `text` parsed, or `undefined` when it is no JSON (a `[DONE]`, a server's own line: says no host). */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // no JSON: the `undefined` below
  }
  return undefined;
}

/** The host a completion or a streamed chunk names, if it does. */
function hostOf(chunk: unknown): string | undefined {
  const provider = isRecord(chunk) ? chunk.provider : undefined;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
}

/**
 * A completion with its host in its `usage` — the very value when it names none and no earlier chunk
 * did (`named`), or has no `usage` to carry it; anything that is no completion as it is.
 */
function withHost(completion: unknown, named?: string): unknown {
  if (!isRecord(completion) || !isRecord(completion.usage)) return completion;
  const host = hostOf(completion) ?? named;
  if (host === undefined) return completion;
  return { ...completion, usage: { ...completion.usage, [SERVED_BY_FIELD]: host } };
}

/** What a streamed answer remembers of its chunks: the last host any of them named (#1005). */
interface StreamMemory {
  host?: string;
}

/** One streamed event with the host in its usage (the usage chunk may name none); none to add → as it came. */
function streamedEvent(payload: string, memory: StreamMemory): Replacement | undefined {
  const chunk = parsed(payload);
  memory.host = hostOf(chunk) ?? memory.host;
  const named = withHost(chunk, memory.host);
  return named === chunk ? undefined : [JSON.stringify(named)];
}

/** A streamed body with the host in each usage, event by event. */
function streamedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const memory: StreamMemory = {};
  return rewrittenEvents(body, {
    data: (payload) => streamedEvent(payload, memory),
    end: () => [],
  });
}

/** The answer with its host copied into its usage; an error or a body that is no completion untouched. */
async function servedResponse(response: Response): Promise<Response> {
  const type = response.headers.get("content-type");
  if (!response.ok || response.body === null || type === null) return response;
  const isStream = type.includes("text/event-stream");
  if (!isStream && !type.includes("json")) return response;
  // the body is read and rewritten: its length and encoding headers no longer describe it
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (isStream) return new Response(streamedBody(response.body), init);
  const text = await response.text();
  const completion = parsed(text);
  const named = withHost(completion);
  return new Response(named === completion ? text : JSON.stringify(named), init);
}

/** A client whose completions carry the host that served them in their `usage`. */
export const servedByFetch =
  (send: typeof fetch): typeof fetch =>
  async (input, init) =>
    servedResponse(await send(input, init));
