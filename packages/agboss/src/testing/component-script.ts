import { WorkflowFinishTextDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import { LiveCallBlockedError, TestFailure, TestSetupError } from "./errors.js";
import { inputText, matchesInput, type RecordedInput } from "./input-match.js";
import type { ModelRequest, ModelScript, WhenScript } from "./model-script.js";
import { TurnQueue } from "./turn-queue.js";
import type { ScriptedCall, ScriptedTurn } from "./turns.js";

/** What a component returned, for `toHaveReturned`: the class and its value (a list's array). */
export interface ReturnedValue {
  readonly dto: DtoClass;
  readonly value: unknown;
}

/** One `when(…)` of a script: its matcher and its turns. */
class WhenEntry implements WhenScript {
  readonly queue = new TurnQueue();

  constructor(readonly partial: RecordedInput) {}

  thenReturn(...turns: readonly ScriptedTurn[]): this {
    this.queue.push(turns);
    return this;
  }

  thenReturnAlways(turn: ScriptedTurn): this {
    this.queue.always(turn);
    return this;
  }
}

/** What a served turn says the component returned (an answer or a text reply), if anything. */
function returnedOf(turn: ScriptedTurn): ReturnedValue | undefined {
  if (turn.kind === "answer") return { dto: turn.dto, value: turn.value };
  if (turn.kind === "reply") return { dto: WorkflowFinishTextDto, value: { text: turn.text } };
  return undefined;
}

/**
 * One component's script: `when(…)` entries first (by input), then its own turns by position, and
 * what it was asked. `bindsInput` — an agent or a model router, whose calls carry their step's input.
 */
export class ComponentScript implements ModelScript {
  readonly requests: ModelRequest[] = [];
  readonly toolCalls: string[] = [];
  readonly inputs: RecordedInput[] = [];
  readonly returned: ReturnedValue[] = [];
  readonly #queue = new TurnQueue();
  readonly #whens: WhenEntry[] = [];
  #handler: ((request: ModelRequest) => ScriptedTurn) | undefined;

  constructor(
    readonly label: string,
    readonly bindsInput: boolean,
  ) {}

  thenReturn(...turns: readonly ScriptedTurn[]): this {
    this.#queue.push(turns);
    return this;
  }

  thenAnswer(handler: (request: ModelRequest) => ScriptedTurn): this {
    this.#handler = handler;
    return this;
  }

  thenReturnAlways(turn: ScriptedTurn): this {
    this.#queue.always(turn);
    return this;
  }

  when(partial: RecordedInput): WhenScript {
    if (!this.bindsInput) {
      throw new TestSetupError(
        `mockLlm(${this.label}).when(…): only agents and model routers are called with an input`,
      );
    }
    const entry = new WhenEntry(partial);
    this.#whens.push(entry);
    return entry;
  }

  get isScripted(): boolean {
    return this.#handler !== undefined || this.#queue.isScripted || this.#whens.length > 0;
  }

  /** The call's turn: a `when(…)` its input matches, else the script's own; recorded. */
  next(request?: ModelRequest, input?: RecordedInput): ScriptedCall {
    if (input !== undefined) this.inputs.push(input);
    const call = this.#callFor(request, input);
    const returned = returnedOf(call.turn);
    if (returned !== undefined) this.returned.push(returned);
    return call;
  }

  #callFor(request: ModelRequest | undefined, input: RecordedInput | undefined): ScriptedCall {
    if (this.#handler !== undefined) return this.#answered(this.#handler, request);
    if (!this.isScripted) {
      throw new LiveCallBlockedError(
        `${this.label} has no script — a live model call is blocked in tests; script it with mockLlm(${this.label}).thenReturn(…)`,
      );
    }
    const matching =
      input === undefined ? [] : this.#whens.filter((entry) => matchesInput(input, entry.partial));
    const call =
      matching.length > 0
        ? matching.map((entry) => entry.queue.take()).find((taken) => taken !== undefined)
        : this.#queue.take();
    return call ?? this.#unanswered(matching, input);
  }

  /** No turn for a call: its scripts ran out, or nothing matched its input. */
  #unanswered(matching: readonly WhenEntry[], input: RecordedInput | undefined): never {
    const [first] = matching;
    if (first !== undefined || this.#queue.isScripted || this.#whens.length === 0) {
      const queue = first?.queue ?? this.#queue;
      throw new TestFailure("test.script-exhausted", queue.exhausted(this.label));
    }
    const message = `no script of mockLlm(${this.label}) matches the input ${inputText(input)}`;
    throw new TestFailure("test.no-matching-script", message);
  }

  /** A `thenAnswer(…)` call: the handler's turn for the request. */
  #answered(
    handler: (request: ModelRequest) => ScriptedTurn,
    request: ModelRequest | undefined,
  ): ScriptedCall {
    if (request === undefined) throw new TestSetupError("thenAnswer(…) needs the request");
    const turn = handler(request);
    if (turn.kind === "wait") throw new TestSetupError("thenAnswer(…) answers, it does not wait");
    return { turn, delay: 0 };
  }

  /** What the test left unused: `thenReturn` turns no call took, `when(…)` nothing matched. */
  leftovers(): readonly string[] {
    const label = `mockLlm(${this.label})`;
    const own = this.#queue.leftoverText(label);
    const whens = this.#whens.flatMap((entry) => {
      const named = `${label}.when(${inputText(entry.partial)})`;
      if (entry.queue.taken === 0 && entry.queue.expectsUse) return [`${named}: never matched`];
      const left = entry.queue.leftoverText(named);
      return left === undefined ? [] : [left];
    });
    return [...(own === undefined ? [] : [own]), ...whens];
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
