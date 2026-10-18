import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { MessageContent } from "@langchain/core/messages";
import type { DecisionQuestions, DecisionState } from "../llm/decisions.js";
import { LiveCallBlockedError, TestFailure } from "./errors.js";
import type { ScriptedTurn } from "./script.js";

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
      /** A judge's `ctx.model.decide`: the state and the questions, as sent. */
      readonly kind: "decide";
      /** The state as text (JSON unless it is a string). */
      readonly input: MessageContent;
      readonly state: DecisionState;
      readonly questions: DecisionQuestions;
    };

/** A component's script and what it was asked: `mockLlm(Scout).thenReturn(replyWith("…"))`. */
export interface ModelScript {
  /** Adds turns, taken by position: the component's n-th model call gets the n-th turn. */
  thenReturn(...turns: readonly ScriptedTurn[]): ModelScript;
  /** The turn every call after the scripted ones gets. */
  thenReturnAlways(turn: ScriptedTurn): ModelScript;
  /** A dynamic closure to handle requests. Overrides respond/thenReturnAlways if set. */
  thenAnswer(handler: (req: ModelRequest) => ScriptedTurn): ModelScript;
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

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/** One component's script: turns by position (its model calls so far in this test), requests. */
export class ComponentScript implements ModelScript {
  readonly requests: ModelRequest[] = [];
  readonly toolCalls: string[] = [];
  #turns: ScriptedTurn[] = [];
  #always: ScriptedTurn | undefined;
  #handler: ((req: ModelRequest) => ScriptedTurn) | undefined;
  #position = 0;

  constructor(readonly label: string) {}

  thenReturn(...turns: readonly ScriptedTurn[]): this {
    this.#turns.push(...turns);
    return this;
  }

  thenAnswer(handler: (req: ModelRequest) => ScriptedTurn): this {
    this.#handler = handler;
    return this;
  }

  thenReturnAlways(turn: ScriptedTurn): this {
    this.#always = turn;
    return this;
  }

  get isScripted(): boolean {
    return this.#handler !== undefined || this.#turns.length > 0 || this.#always !== undefined;
  }

  /** The turn for the next call; unscripted → blocked, past the end → exhausted. */
  next(req?: ModelRequest): ScriptedTurn {
    if (this.#handler !== undefined) {
      if (!req) throw new Error("ModelRequest is required when using .thenAnswer()");
      return this.#handler(req);
    }
    if (!this.isScripted) {
      throw new LiveCallBlockedError(
        `${this.label} has no script — a live model call is blocked in tests; script it with mockLlm(${this.label}).thenReturn(…)`,
      );
    }
    const turn = this.#turns[this.#position] ?? this.#always;
    this.#position += 1;
    if (turn === undefined) {
      throw new TestFailure(
        "test.script-exhausted",
        `script exhausted for ${this.label}: ${plural(this.#turns.length, "turn")} scripted, asked for #${String(this.#position)} — add turns or end with .thenReturnAlways(…)`,
      );
    }
    return turn;
  }

  get onlyRequest(): ModelRequest {
    const [only, ...rest] = this.requests;
    if (only === undefined || rest.length > 0) {
      throw new TestFailure(
        "test.wrong-script",
        `mockLlm(${this.label}).onlyRequest: expected exactly one request, got ${String(this.requests.length)}`,
      );
    }
    return only;
  }

  get lastRequest(): ModelRequest {
    const last = this.requests.at(-1);
    if (last === undefined) {
      throw new TestFailure("test.wrong-script", `mockLlm(${this.label}): no request was sent`);
    }
    return last;
  }
}

/**
 * Every component's script in one test, shared by every app the test opens — so a run resumed in a
 * new app continues the same script. Failures that must fail the test are kept until reported.
 */
export class ScriptBook {
  readonly #scripts = new Map<string, ComponentScript>();
  readonly #labels = new Map<string, string>();
  readonly #failures: Error[] = [];
  #toolCallIds = 0;

  /** How the test names the component behind a key (its class), for messages. */
  name(key: string, label: string): void {
    this.#labels.set(key, label);
  }

  scriptOf(key: string): ComponentScript {
    const existing = this.#scripts.get(key);
    if (existing !== undefined) return existing;
    const created = new ComponentScript(this.#labels.get(key) ?? key);
    this.#scripts.set(key, created);
    return created;
  }

  /** A tool call id unique within the test (results are keyed by it). */
  nextToolCallId(): string {
    this.#toolCallIds += 1;
    return `call-${String(this.#toolCallIds)}`;
  }

  /** Remembers a failure the test must see, even if a run swallowed it (a tool error, a guard). */
  report(failure: Error): Error {
    this.#failures.push(failure);
    return failure;
  }

  /** The first failure reported since the last call, if any (then forgotten). */
  takeFailure(): Error | undefined {
    const [first] = this.#failures;
    this.#failures.length = 0;
    return first;
  }
}
