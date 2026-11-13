import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Callbacks } from "@langchain/core/callbacks/manager";

/**
 * The token handler of one answering model call (#1004): the only place the user's stream hears a
 * model. It is added to that call's own `callbacks` — never to the run's — and awaited, so every
 * token has been handled when the call returns.
 */
export class AnswerTokenHandler extends BaseCallbackHandler {
  name = "AnswerTokenHandler";
  override awaitHandlers = true;

  constructor(private readonly onToken: (token: string) => void) {
    super();
  }

  override handleLLMNewToken(token: string): void {
    if (token !== "") this.onToken(token);
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
