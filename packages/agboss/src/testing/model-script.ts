import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { MessageContent } from "@langchain/core/messages";
import type { DecisionQuestions, DecisionState } from "../llm/decisions.js";
import type { InputMatcherOf, RecordedInputOf, TurnFor } from "./script-types.js";
import type { ScriptedTurn } from "./turns.js";

/** One message of a chat request: who said it and its text. */
export interface ChatLine {
  readonly role: string;
  readonly text: MessageContent;
}

/** What a component sent its model: an agent's chat, a router's decision request, or a judge's decision. */
export type ModelRequest =
  | {
      readonly kind: "chat";
      readonly system: string;
      /** The input message (#270 Q51). */
      readonly input: MessageContent;
      readonly messages: readonly ChatLine[];
      /** The tools the agent bound — its own and its answer tools, as the model sees them. */
      readonly tools: readonly ToolDefinition[];
    }
  | {
      readonly kind: "decision";
      readonly input: MessageContent;
      readonly options: readonly string[];
      /** Each option's route text as the router's model got it. */
      readonly routes: Readonly<Record<string, string>>;
      readonly instructions: string;
    }
  | {
      /** A judge's `judgeModel.decide`: the state and the questions, as sent. */
      readonly kind: "decide";
      /** The state as text (JSON unless it is a string). */
      readonly input: MessageContent;
      readonly state: DecisionState;
      readonly questions: DecisionQuestions;
    };

/**
 * The script of one `when(…)`: the calls whose input matches it take its turns, by position.
 * Its `thenReturn` turns are expected: one never used fails the test at its end (#262 AC7).
 */
export interface WhenScript<TSelf = unknown> {
  thenReturn(...turns: readonly TurnFor<TSelf>[]): WhenScript<TSelf>;
  /** The turn every matching call after the scripted ones gets (never a leftover). */
  thenReturnAlways(turn: TurnFor<TSelf>): WhenScript<TSelf>;
}

/**
 * A component's script and what it was asked: `mockLlm(ScoutAgent).thenReturn(replyWith("…"))`.
 * Turns are checked at compile time against the generated types of the component (#262).
 */
export interface ModelScript<TSelf = unknown> {
  /** Adds turns, taken by position: the component's n-th model call gets the n-th turn. */
  thenReturn(...turns: readonly TurnFor<TSelf>[]): ModelScript<TSelf>;
  /** The turn every call after the scripted ones gets (never a leftover). */
  thenReturnAlways(turn: TurnFor<TSelf>): ModelScript<TSelf>;
  /** A dynamic closure to handle requests. Overrides the turns if set. */
  thenAnswer(handler: (request: ModelRequest) => ScriptedTurn): ModelScript<TSelf>;
  /**
   * Binds turns to the calls whose input matches, at any depth — `when({ review: undefined })` for
   * the first visit of a loop, `when({ companies: [] })` for an empty list. Agents and model
   * routers only; a call no script matches fails the test, naming its input.
   */
  when(partial: InputMatcherOf<TSelf>): WhenScript<TSelf>;
  /** The node's input of every model call, in order (`Produced` records, as the node read it). */
  readonly inputs: readonly RecordedInputOf<TSelf>[];
  /** Every request, in order. */
  readonly requests: readonly ModelRequest[];
  /** The one request (fails unless there was exactly one). */
  readonly onlyRequest: ModelRequest;
  /** The last request (fails when there was none). */
  readonly lastRequest: ModelRequest;
  /** The tools the component's model called, in order (tool names). */
  readonly toolCalls: readonly string[];
  /** How the test names the component (its class). */
  readonly label: string;
}
