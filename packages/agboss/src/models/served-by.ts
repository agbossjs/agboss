/**
 * Which host served a call (#395 PR 6): OpenRouter names it in every completion (`provider`, a JSON
 * answer or each streamed chunk), but the chat client keeps only the answer's `usage`. This fetch
 * copies the host into that `usage` as `SERVED_BY_FIELD`, which `recordUsage` reads as
 * `UsageRecord.servedBy` — for a plain and for a streamed answer alike.
 */

import { SERVED_BY_FIELD } from "../finops/served-by.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A completion with its host in its `usage`; anything else as it is. */
function withHost(completion: unknown): unknown {
  if (!isRecord(completion)) return completion;
  const { provider, usage } = completion;
  if (typeof provider !== "string" || !isRecord(usage)) return completion;
  return { ...completion, usage: { ...usage, [SERVED_BY_FIELD]: provider } };
}

/** One `data: {…}` line of a streamed answer with the host in its usage. */
function streamedLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") return line;
  try {
    return `data: ${JSON.stringify(withHost(JSON.parse(payload)))}`;
  } catch {
    return line;
  }
}

/** A streamed body, line by line (a line may span chunks). */
function streamedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(encoder.encode(`${streamedLine(line)}\n`));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending !== "") controller.enqueue(encoder.encode(streamedLine(pending)));
      },
    }),
  );
}

/** The answer with its host copied into its usage; an error or a body that is no completion untouched. */
async function servedResponse(response: Response): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const type = response.headers.get("content-type") ?? "";
  // the body is read and rewritten: its length and encoding headers no longer describe it
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (type.includes("text/event-stream")) return new Response(streamedBody(response.body), init);
  if (!type.includes("json")) return response;
  const text = await response.text();
  try {
    return new Response(JSON.stringify(withHost(JSON.parse(text))), init);
  } catch {
    return new Response(text, init);
  }
}

/** A client whose completions carry the host that served them in their `usage`. */
export const servedByFetch =
  (send: typeof fetch): typeof fetch =>
  async (input, init) =>
    servedResponse(await send(input, init));
