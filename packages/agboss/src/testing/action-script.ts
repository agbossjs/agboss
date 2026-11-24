import type { OnActionEnd, OnActionStart } from "../core/observer-hooks.js";
import type { ActionEndEvent, ActionStartEvent } from "../core/observability.js";
import type { DtoClass } from "../dto/types.js";
import { variantClassOf } from "../flow/dto-wrappers.js";
import type { RecordedInput } from "./input-match.js";
import type { ReturnedValue } from "./script-book.js";
import type { RecordedInputOf } from "./script-types.js";

/**
 * `mockAction(A)` (#262 AC9): the action still runs; its calls are recorded — what it received
 * (an error handler's input too) and what it returned — for `inputs` and the call matchers.
 */
export interface ActionScript<TSelf = unknown> {
  /** The action's input of every call, in order (`Produced` records, as it read them). */
  readonly inputs: readonly RecordedInputOf<TSelf>[];
  /** How the test names the action (its class). */
  readonly label: string;
}

/** One action's recorded calls. */
export class ActionCalls implements ActionScript {
  readonly inputs: RecordedInput[] = [];
  readonly returned: ReturnedValue[] = [];

  constructor(readonly label: string) {}
}

/** The class an action's result is: its `variant(…)`, else its declared output's (a list's element). */
export type OutputClassOf = (action: string) => DtoClass | undefined;

/**
 * Records every action call of a test's applications by its `name` — registered as one more
 * observer of each instance, so the matchers see the real action's input and result.
 */
export class ActionCallRecorder implements OnActionStart, OnActionEnd {
  readonly #calls = new Map<string, ActionCalls>();

  constructor(
    private readonly labelOf: (action: string) => string,
    private readonly outputClassOf: OutputClassOf,
  ) {}

  callsOf(action: string): ActionCalls {
    const existing = this.#calls.get(action);
    if (existing !== undefined) return existing;
    const created = new ActionCalls(this.labelOf(action));
    this.#calls.set(action, created);
    return created;
  }

  onActionStart(event: ActionStartEvent): void {
    this.callsOf(event.step.component.name).inputs.push(event.input);
  }

  onActionEnd(event: ActionEndEvent): void {
    const name = event.step.component.name;
    const update: unknown = event.update;
    // a list result names its class on its elements (`variant(…)`), a single one on itself
    const first: unknown = Array.isArray(update) ? (update as readonly unknown[])[0] : update;
    const dto = variantClassOf(first) ?? this.outputClassOf(name);
    if (dto !== undefined) this.callsOf(name).returned.push({ dto, value: event.update });
  }
}
