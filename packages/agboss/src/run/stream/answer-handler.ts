import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { AttemptStream } from "./agent-stream.js";
import { STREAM_DISCARD_EVENT } from "../../models/stream-discard.js";

/**
 * The token handler of one answering model call (#1004): the only place the user's stream hears a
 * model. It is added to that call's own `callbacks` — never to the run's — and awaited, so every
 * token has been handled when the call returns.
 */
export class AnswerTokenHandler extends BaseCallbackHandler {
  name = "AnswerTokenHandler";
  override awaitHandlers = true;

  /**
   * The call is made as a stream (#1005): LangChain asks each handler. A held attempt (#1006) is a
   * stream too — its tokens go to the holding buffer and out only after the visit's checks passed, so
   * what the wire carries to the provider is no concern of the consumer's stream (#1122).
   */
  readonly lc_prefer_streaming = true;

  constructor(private readonly attempt: AttemptStream) {
    super();
  }

  /** The model started its answer over (a fallback after its primary died mid-stream, #1005). */
  override handleCustomEvent(eventName: string): void {
    if (eventName === STREAM_DISCARD_EVENT) this.attempt.restart("stream-broken");
  }

  override handleLLMNewToken(token: string): void {
    this.attempt.push(token); // an empty token shows nothing
  }
}

/** The call's callbacks (tracing among them) with `handler` added; the others stay as they are. */
export function withAnswerHandler(
  callbacks: Callbacks | undefined,
  handler: AnswerTokenHandler,
): Callbacks {
  if (callbacks === undefined) return [handler];
  return Array.isArray(callbacks) ? [...callbacks, handler] : callbacks.copy([handler]);
}
