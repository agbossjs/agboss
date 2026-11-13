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

/**
 * Scripted chat models write their text in pieces of `size` characters, as a streaming provider
 * does (the scripted model writes a text as one token): `useChunks()` installs it for a test file,
 * the test sets `chunks.size` (default 1).
 */
export const chunks = { size: 1 };

export function useChunks(): void {
  const original: ScriptedChatModel["_generate"] = Reflect.get(
    ScriptedChatModel.prototype,
    "_generate",
  );
  beforeEach(() => {
    chunks.size = 1;
    ScriptedChatModel.prototype._generate = async function (
      this: ScriptedChatModel,
      messages,
      options,
      runManager,
    ) {
      const result = await original.call(this, messages, options, undefined);
      const text = result.generations[0]?.text ?? "";
      for (let at = 0; at < text.length; at += chunks.size) {
        await runManager?.handleLLMNewToken(text.slice(at, at + chunks.size));
      }
      return result;
    };
  });
  afterEach(() => {
    ScriptedChatModel.prototype._generate = original;
  });
}
