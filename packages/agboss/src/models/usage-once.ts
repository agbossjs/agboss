import { withRewrittenEvents, type EventRewrite, type Replacement } from "./event-stream-lines.js";

/**
 * #1231: a streamed answer's usage, once — taken where the chat client reads the wire.
 *
 * The answer is the chunks merged, and LangChain's merge adds numbers and joins strings. LangChain
 * copies a chunk's `usage` into that chunk's metadata and yields a usage chunk of its own with the
 * provider's last `usage` — so a provider that sends the usage beside a choice (OpenRouter's last
 * chunk) or on several chunks had its `usage.cost` counted twice or more and its host (`servedBy`)
 * written twice. So the stream the client reads carries one usage report: every chunk's `usage`
 * leaves it, and the provider's last report comes as one chunk of its own with no choice (OpenAI's
 * `stream_options.include_usage` shape) right before `[DONE]`, or at the body's end without one.
 *
 * This is the client's fetch — the one boundary every copy of the client keeps: `bindTools`,
 * `withConfig`, `withStructuredOutput`, `withRetry` and `withFallbacks` make or wrap clients of the
 * same fields, never of another fetch (a subclass of the client is lost in `withConfig`, which
 * makes a plain `ChatOpenAI`: acceptance H of #1231).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DONE = "[DONE]";

// Stryker disable BlockStatement: an empty catch returns `undefined` too — the same answer
/** `payload` parsed, or `undefined` when it is no JSON (a server's own line, says nothing of usage). */
function parsed(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
// Stryker restore BlockStatement

/** The rewrite of one streamed body: the last usage held back, given once. */
function usageOnce(): EventRewrite {
  let held: Record<string, unknown> | undefined;
  const release = (): string | undefined => {
    // Stryker disable next-line ConditionalExpression: `JSON.stringify(undefined)` is `undefined` too
    if (held === undefined) return undefined;
    const event = JSON.stringify(held);
    held = undefined;
    return event;
  };
  return {
    data(payload): Replacement | undefined {
      // as the OpenAI client reads it: the payload starts with it (no trimming, so ` [DONE]` is none)
      if (payload.startsWith(DONE)) {
        const usage = release();
        return usage === undefined ? undefined : [usage, payload];
      }
      const chunk = parsed(payload);
      if (!isRecord(chunk) || !("usage" in chunk)) return undefined;
      const { usage, ...rest } = chunk;
      // the last report is the call's (a provider may send a running one on earlier chunks)
      if (isRecord(usage)) held = { ...rest, choices: [], usage };
      return [JSON.stringify(rest)];
    },
    end() {
      const usage = release();
      return usage === undefined ? [] : [usage];
    },
  };
}

/** A client whose streamed answers carry their usage once, in a chunk of its own, last. */
export const usageOnceFetch =
  (send: typeof fetch): typeof fetch =>
  async (input, init) =>
    withRewrittenEvents(await send(input, init), usageOnce);
