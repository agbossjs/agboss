import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { ActionEndEvent, ActionStartEvent } from "../core/observability.js";
import type { DtoClass } from "../dto/types.js";
import { isDtoClass } from "../dto/metadata.js";
import type { RecordedInput } from "./input-match.js";
import type { ReturnedValue } from "./script-book.js";
import type { RecordedInputOf } from "./script-types.js";

/**
 * `mockAction(A)` (#262 AC9): the action still runs; its calls are recorded — what it received
 * (an error handler's input too) and what it returned — for `inputs` and the call matchers.
 */
export interface ActionScript<TSelf = unknown> {
  /** The action's input of every call, in order (tracked DTOs, as it read them). */
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

/** The class an action's result is: its declared output's (a list's element). */
export type OutputClassOf = (action: string, value: unknown) => DtoClass | undefined;

/** The DTO class a validated value is an instance of. */
function classOfInstance(value: unknown): DtoClass | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const constructor = (Object.getPrototypeOf(value) as { constructor?: unknown } | null)
    ?.constructor;
  return isDtoClass(constructor) ? constructor : undefined;
}

/**
 * Records every action call of a test's applications by its `name` — registered as one more
 * observer of each instance, so the matchers see the real action's input and result.
 */
export class ActionCallRecorder implements ExecutionObserver {
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
    const update: unknown = event.output;
    // a validated result is an instance of its class (a list's first element for a list result)
    const first: unknown = Array.isArray(update) ? (update as readonly unknown[])[0] : update;
    const dto = classOfInstance(first) ?? this.outputClassOf(name, first);
    if (dto !== undefined) this.callsOf(name).returned.push({ dto, value: event.output });
  }
}
