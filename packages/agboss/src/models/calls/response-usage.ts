/**
 * The real usage of a call, read from its answer as it is streamed to the caller (#266: a
 * provider's `perMinute.tokens`): OpenAI-compatible bodies — JSON or server-sent events — end with
 * a `usage` object. Only the tail of the body is kept.
 */

/** How much of a body's end is kept to read its usage from. */
const KEPT = 16_384;

const lastNumber = (text: string, field: string): number | undefined => {
  const matches = [...text.matchAll(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, "g"))];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
};

/** The tokens a body's usage reports: `total_tokens`, else prompt + completion; 0 when none. */
export function tokensIn(text: string): number {
  const total = lastNumber(text, "total_tokens");
  if (total !== undefined) return total;
  return (lastNumber(text, "prompt_tokens") ?? 0) + (lastNumber(text, "completion_tokens") ?? 0);
}

/**
 * The same answer, its body passed through as it is read: when it ends, `release(tokens)` gets the
 * usage it reported; when it fails or the caller cancels it, `release(0)`.
 */
export function releasedAtBodyEnd(
  response: Response,
  release: (tokens: number) => Promise<void>,
): Response {
  const source = response.body;
  if (source === null) {
    void release(0);
    return response;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = source.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await release(tokensIn(tail + decoder.decode()));
          return;
        }
        tail = (tail + decoder.decode(value, { stream: true })).slice(-KEPT);
        controller.enqueue(value);
      } catch (error) {
        await release(0);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await release(0);
      await reader.cancel(reason);
    },
  });
  const { status, statusText, headers } = response;
  return new Response(body, { status, statusText, headers });
}
