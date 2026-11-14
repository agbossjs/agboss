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
   * Whether the call is made as a stream (#1005): LangChain asks each handler. An attempt whose text
   * is held back never goes on the wire, so it is a plain call and pays nothing for a stream.
   */
  readonly lc_prefer_streaming: boolean;

  constructor(private readonly attempt: AttemptStream) {
    super();
    this.lc_prefer_streaming = !attempt.isHeld;
  }

  /** The model started its answer over (a fallback after its primary died mid-stream, #1005). */
  override handleCustomEvent(eventName: string): void {
    if (eventName === STREAM_DISCARD_EVENT) this.attempt.restart("stream-broken");
  }

  override handleLLMNewToken(token: string): void {
    if (token !== "") this.attempt.push(token);
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
