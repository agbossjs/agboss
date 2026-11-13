/**
 * The canary (#1004): every scripted chat model of the test writes a token before it answers, so
 * every internal model call — whichever kind — is one that would have reached the user's stream
 * under the old handler. The user's stream may carry the canary of the agent's own answering call
 * only: `useCanary()` installs it for a test file, `canaries(events)` counts what was heard.
 */
import { afterEach, beforeEach } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { ScriptedChatModel } from "../../src/testing/scripted-chat-model.js";

export const CANARY = "CANARY";

export function useCanary(): void {
  const original: ScriptedChatModel["_generate"] = Reflect.get(
    ScriptedChatModel.prototype,
    "_generate",
  );
  beforeEach(() => {
    ScriptedChatModel.prototype._generate = async function (
      this: ScriptedChatModel,
      messages,
      options,
      runManager,
    ) {
      await runManager?.handleLLMNewToken(CANARY);
      return original.call(this, messages, options, runManager);
    };
  });
  afterEach(() => {
    ScriptedChatModel.prototype._generate = original;
  });
}

/** How many canaries the user's stream heard. */
export const canaries = (events: readonly ExecutionStreamEvent[]): number =>
  events.filter((event) => event.kind === "textDelta" && event.delta === CANARY).length;
