import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import type { MoveModel } from "./types.js";

/** One scripted call of a tool. */
export interface ScriptedCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** One scripted model move: an answer streamed char by char, or tool calls. */
export type ScriptedMove =
  | { readonly kind: "answer"; readonly text: string; readonly sleepMs?: number }
  | { readonly kind: "calls"; readonly calls: readonly ScriptedCall[] };

export const answer = (text: string, sleepMs = 0): ScriptedMove => ({
  kind: "answer",
  text,
  sleepMs,
});
export const callTools = (...calls: ScriptedCall[]): ScriptedMove => ({ kind: "calls", calls });

export class ScriptExhaustedError extends Error {
  override name = "ScriptExhaustedError";
}

const modelFor = (move: ScriptedMove): FakeStreamingChatModel =>
  move.kind === "answer"
    ? new FakeStreamingChatModel({
        responses: [new AIMessage(move.text)],
        sleep: move.sleepMs ?? 0,
      })
    : new FakeStreamingChatModel({
        chunks: [
          new AIMessageChunk({
            content: "",
            tool_calls: move.calls.map((call) => ({ ...call, type: "tool_call" as const })),
          }),
        ],
      });

/**
 * Stock fakes cannot script a multi-turn tool conversation (FakeListChatModel: text only;
 * FakeStreamingChatModel: always the same answer), so the script picks the move by the
 * conversation — the number of model moves so far — never by call order. That also makes it
 * survive a process restart: the resumed process continues the same script.
 */
export function scriptedModel(
  moves: readonly ScriptedMove[],
  onCall: (moveIndex: number) => void = () => undefined,
): MoveModel {
  return (conversation: readonly BaseMessage[]) => {
    const index = conversation.filter((message) => AIMessage.isInstance(message)).length;
    const move = moves[index];
    if (move === undefined) throw new ScriptExhaustedError(`No scripted move #${String(index)}`);
    onCall(index);
    return modelFor(move);
  };
}
